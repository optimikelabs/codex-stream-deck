import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import type { CodexModel, CodexThread, CodexTurn } from "./domain.js";
import type { DiagnosticLogger } from "./logger.js";

type JsonRpcId = number | string;

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcMethod {
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcMethod;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export class JsonlFramer {
  #buffer = "";
  readonly #maxLineBytes: number;

  constructor(maxLineBytes = 5 * 1024 * 1024) {
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk: Buffer | string): string[] {
    this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxLineBytes) {
      this.#buffer = "";
      throw new Error("App-server JSONL frame exceeds size limit");
    }
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim().length > 0);
  }
}

export interface AppServerEvents {
  notification: (method: string, params: Record<string, unknown>) => void;
  approvalAutoDeclined: (method: string, params: Record<string, unknown>) => void;
  exit: (error?: Error) => void;
}

export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
}

export interface ThreadReadResponse {
  thread: CodexThread;
}

export interface ModelListResponse {
  data: CodexModel[];
  nextCursor: string | null;
}

export function turnNeedsHydration(turn: CodexTurn): boolean {
  return turn.itemsView === "notLoaded" || !Array.isArray(turn.items) || turn.items.length === 0;
}

export class CodexAppServer extends EventEmitter {
  readonly #logger: DiagnosticLogger;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #pending = new Map<JsonRpcId, PendingRequest>();
  #framer = new JsonlFramer();
  #completedTurns = new Map<string, CodexTurn>();
  #stopping = false;

  constructor(logger: DiagnosticLogger) {
    super();
    this.#logger = logger;
  }

  override on<K extends keyof AppServerEvents>(event: K, listener: AppServerEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof AppServerEvents>(event: K, ...args: Parameters<AppServerEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  get connected(): boolean {
    return !!this.#child && this.#child.exitCode === null && !this.#child.killed;
  }

  async start(codexPath: string): Promise<Record<string, unknown>> {
    await this.stop();
    this.#stopping = false;
    this.#framer = new JsonlFramer();
    this.#completedTurns.clear();
    const javascriptEntry = /\.m?js$/i.test(codexPath);
    const command = javascriptEntry ? process.execPath : codexPath;
    const child = spawn(command, [...(javascriptEntry ? [codexPath] : []), "app-server", "--listen", "stdio://"], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    child.stderr.on("data", () => this.#logger.debug("Codex app-server wrote to stderr"));
    child.on("exit", (code, signal) => this.#onExit(code, signal));
    child.on("error", (error) => this.#onProcessError(error));

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    const initialized = await this.request<Record<string, unknown>>(
      "initialize",
      {
        clientInfo: { name: "codex_stream_deck", title: "Codex Stream Deck", version: "0.2.0" }
      },
      15_000
    );
    this.notify("initialized", {});
    this.#logger.info("Connected to Codex app-server");
    return initialized;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    this.#rejectAll(new Error("Codex app-server stopped"));
  }

  request<T>(method: string, params: Record<string, unknown> | undefined, timeoutMs = 30_000): Promise<T> {
    if (!this.#child?.stdin.writable) return Promise.reject(new Error("Codex app-server is not connected"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        startedAt: Date.now()
      });
      try {
        this.#send({ method, id, params: params ?? {} });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("Failed to write app-server request"));
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.#send({ method, params });
  }

  async listThreads(sourceKinds: string[]): Promise<ThreadListResponse> {
    const base = {
      limit: 100,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds,
      archived: false
    };
    try {
      return await this.request<ThreadListResponse>("thread/list", base, 30_000);
    } catch (error) {
      if (!(error instanceof RpcError)) throw error;
      this.#logger.warn("thread/list filters unsupported; retrying compatible subset", { code: error.code });
      return this.request<ThreadListResponse>("thread/list", { limit: 100, archived: false }, 30_000);
    }
  }

  async listModels(): Promise<ModelListResponse> {
    return this.request<ModelListResponse>("model/list", { limit: 100, includeHidden: false }, 30_000);
  }

  async readTurn(threadId: string, turnId: string): Promise<CodexTurn | undefined> {
    const response = await this.request<ThreadReadResponse>(
      "thread/read",
      { threadId, includeTurns: true },
      30_000
    );
    return response.thread.turns?.find((turn) => turn.id === turnId);
  }

  async waitForTurn(threadId: string, turnId: string, timeoutMs: number): Promise<CodexTurn> {
    const key = `${threadId}:${turnId}`;
    const completed = this.#completedTurns.get(key);
    if (completed) {
      this.#completedTurns.delete(key);
      return completed;
    }
    return new Promise<CodexTurn>((resolve, reject) => {
      const listener = (method: string, params: Record<string, unknown>): void => {
        if (method !== "turn/completed" || params.threadId !== threadId) return;
        const turn = params.turn as CodexTurn | undefined;
        if (!turn || turn.id !== turnId) return;
        cleanup();
        this.#completedTurns.delete(key);
        resolve(turn);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Turn completion timed out"));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off("notification", listener);
      };
      this.on("notification", listener);
    });
  }

  #onData(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.#framer.push(chunk);
    } catch (error) {
      this.#logger.error("Rejected oversized app-server frame");
      void this.stop();
      return;
    }
    for (const line of lines) {
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.#logger.warn("Skipped malformed app-server JSONL line");
        continue;
      }
      if (!isRecord(message)) {
        this.#logger.warn("Skipped invalid app-server JSON-RPC message");
        continue;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      const params = isRecord(message.params) ? message.params : {};
      if (isJsonRpcId(message.id)) this.#handleServerRequest(message.id, message.method, params);
      else {
        if (message.method === "turn/completed") {
          const threadId = params.threadId;
          const turn = params.turn as CodexTurn | undefined;
          if (typeof threadId === "string" && turn?.id) {
            this.#completedTurns.set(`${threadId}:${turn.id}`, turn);
            if (this.#completedTurns.size > 20) this.#completedTurns.delete(this.#completedTurns.keys().next().value as string);
          }
        }
        this.emit("notification", message.method, params);
      }
      return;
    }

    if (!isJsonRpcId(message.id)) {
      this.#logger.warn("Skipped app-server response without a valid ID");
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    this.#logger.debug("Codex request completed", { method: pending.method, durationMs: Date.now() - pending.startedAt });
    const rpcError = isRecord(message.error) ? message.error : undefined;
    if (rpcError) {
      const code = typeof rpcError.code === "number" && Number.isFinite(rpcError.code) ? rpcError.code : -32_603;
      const errorMessage = typeof rpcError.message === "string" ? rpcError.message.slice(0, 2_000) : "Unknown app-server error";
      pending.reject(new RpcError(code, errorMessage, rpcError.data));
    }
    else pending.resolve(message.result);
  }

  #handleServerRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): void {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      this.#send({ id, result: { decision: "decline" } });
      this.emit("approvalAutoDeclined", method, params);
      return;
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      this.#send({ id, result: { decision: "denied" } });
      this.emit("approvalAutoDeclined", method, params);
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.#send({ id, result: { action: "decline", content: null, _meta: null } });
      this.emit("approvalAutoDeclined", method, params);
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.#send({ id, result: { answers: {} } });
      this.emit("approvalAutoDeclined", method, params);
      return;
    }
    if (/approval|permission/i.test(method)) {
      this.#send({ id, error: { code: -32_000, message: "Declined by Stream Deck safety policy" } });
      this.emit("approvalAutoDeclined", method, params);
      return;
    }
    this.#send({ id, error: { code: -32_601, message: "Unsupported server request" } });
    this.#logger.warn("Rejected unsupported server request", { method });
  }

  #send(message: Record<string, unknown>): void {
    const stdin = this.#child?.stdin;
    if (!stdin?.writable) throw new Error("Codex app-server input is unavailable");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStopping = this.#stopping;
    this.#child = undefined;
    const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`);
    this.#rejectAll(error);
    if (!wasStopping) {
      this.#logger.warn("Codex app-server exited unexpectedly", { code, signal });
      this.emit("exit", error);
    }
  }

  #onProcessError(error: Error): void {
    this.#rejectAll(error);
    if (!this.#stopping) this.emit("exit", error);
  }

  #rejectAll(error: Error): void {
    for (const request of this.#pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.#pending.clear();
  }
}
