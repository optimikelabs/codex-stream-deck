# Changelog

All notable changes to this project are documented here.

## 0.2.0 — 2026-07-16

- Added dynamic model discovery through the official `model/list` App Server request.
- Added Auto, Sol, Terra, and Luna preset keys whose availability follows the runtime model catalog.
- Added an effort key that cycles only through the efforts supported by the selected model.
- Applied active model and effort presets to plugin-owned task creation, including blank new-task composers.
- Added a reversible installer for the XL preset row and native Model/Effort selector shortcuts.
- Localized the preset controls and status summary in the Property Inspector.

## 0.1.1 — 2026-07-16

- Added French labels for project states, utility keys, and the Stream Deck action catalog.
- Recovered completed status turns with `thread/read` when notifications omit unloaded turn items.
- Added a short six-step attention pulse when a task enters an urgent state.
- Kept the pulse bounded and restored the normal key image automatically.

## 0.1.0 — 2026-07-15

- Initial public release of Codex Control for Stream Deck.
- Added recent-task buttons with meaningful Codex task titles, workflow states, freshness, and attention indicators.
- Added exact-task opening, safe status checks, refresh, task creation, editor, review, interrupt, health, settings, and skills actions.
- Added optional loopback-only, token-authenticated passive notify bridge with atomic spool fallback.
- Added strict status schema, bounded local cache, secret-redacted logs, and defensive approval rejection.
- Added security hardening for app-server messages, persisted settings, notify events, Python helpers, Property Inspector CSP, and release privacy.
- Added setup, architecture, development, security, and release documentation.
- Adopted the MIT license and neutral, non-identifying release metadata.
