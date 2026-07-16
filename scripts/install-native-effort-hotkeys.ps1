param(
  [string]$ProfilesRoot = "$env:APPDATA\Elgato\StreamDeck\ProfilesV3",
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" })
)

$ErrorActionPreference = "Stop"

$decreaseCommand = "composer.decreaseReasoningEffort"
$increaseCommand = "composer.increaseReasoningEffort"
$decreaseAccelerator = "Ctrl+Alt+Shift+U"
$increaseAccelerator = "Ctrl+Alt+Shift+O"

function New-KeyEvent([int]$keyCode) {
  [pscustomobject]@{
    KeyCmd = $false
    KeyCtrl = $true
    KeyModifiers = 7
    KeyOption = $true
    KeyShift = $true
    NativeCode = $keyCode
    QTKeyCode = $keyCode
    VKeyCode = $keyCode
  }
}

function New-EmptyKeyEvent() {
  [pscustomobject]@{
    KeyCmd = $false
    KeyCtrl = $false
    KeyModifiers = 0
    KeyOption = $false
    KeyShift = $false
    NativeCode = 146
    QTKeyCode = 33554431
    VKeyCode = -1
  }
}

function New-NativeEffortAction([string]$title, [int]$increaseSteps) {
  $hotkeys = @()

  # Five decreases always reach the lowest supported effort. The native Codex
  # command clamps at the first option instead of wrapping around.
  for ($index = 0; $index -lt 5; $index++) {
    $hotkeys += New-KeyEvent 85 # U
  }
  for ($index = 0; $index -lt $increaseSteps; $index++) {
    $hotkeys += New-KeyEvent 79 # O
  }
  for ($index = 0; $index -lt 3; $index++) {
    $hotkeys += New-EmptyKeyEvent
  }

  [pscustomobject]@{
    ActionID = [guid]::NewGuid().ToString()
    LinkedTitle = $true
    Name = "Hotkey"
    Plugin = [pscustomobject]@{
      Name = "Hotkey"
      UUID = "com.elgato.streamdeck.system.hotkey"
      Version = "1.0"
    }
    Resources = $null
    Settings = [pscustomobject]@{
      Coalesce = $true
      Hotkeys = $hotkeys
    }
    State = 0
    States = @([pscustomobject]@{
      FontSize = 11
      FontStyle = "Bold"
      ShowTitle = $true
      Title = $title
      TitleAlignment = "middle"
      TitleColor = "#FDE68A"
    })
    UUID = "com.elgato.streamdeck.system.hotkey"
  }
}

function Install-CodexKeybindings([string]$codexHomePath) {
  New-Item -ItemType Directory -Path $codexHomePath -Force | Out-Null
  $path = Join-Path $codexHomePath "keybindings.json"
  $bindings = @()

  if (Test-Path -LiteralPath $path) {
    $backup = "$path.pre-stream-deck-effort-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
    Copy-Item -LiteralPath $path -Destination $backup
    $raw = Get-Content -LiteralPath $path -Raw
    if ($raw.Trim()) {
      $bindings = @(ConvertFrom-Json -InputObject $raw -Depth 20)
    }
    Write-Output "Keybindings backup: $backup"
  }

  $bindings = @($bindings | Where-Object {
    $_.command -notin @($decreaseCommand, $increaseCommand)
  })
  $bindings += [pscustomobject]@{ command = $decreaseCommand; key = $decreaseAccelerator }
  $bindings += [pscustomobject]@{ command = $increaseCommand; key = $increaseAccelerator }
  $bindings = @($bindings | Sort-Object command, key)

  ConvertTo-Json -InputObject $bindings -Depth 20 |
    Set-Content -LiteralPath $path -Encoding utf8
  Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -Depth 20 | Out-Null
  Write-Output "Codex keybindings: $path"
}

$manifest = Get-ChildItem -LiteralPath $ProfilesRoot -Recurse -Filter manifest.json |
  Where-Object { (Get-Content -LiteralPath $_.FullName -Raw) -match 'com\.codexstreamdeck\.control\.effort-preset' } |
  Select-Object -First 1
if (-not $manifest) {
  throw "No Codex profile with fixed effort actions was found under $ProfilesRoot"
}

$json = Get-Content -LiteralPath $manifest.FullName -Raw | ConvertFrom-Json -Depth 100
$actions = $json.Controllers[0].Actions
$levels = @{
  low = @{ title = "LÉGER"; steps = 0 }
  medium = @{ title = "MOYEN"; steps = 1 }
  high = @{ title = "ÉLEVÉ"; steps = 2 }
  xhigh = @{ title = "TRÈS`nÉLEVÉ"; steps = 3 }
  max = @{ title = "MAX"; steps = 4 }
  ultra = @{ title = "ULTRA"; steps = 5 }
}

$converted = 0
foreach ($property in @($actions.PSObject.Properties)) {
  $action = $property.Value
  if ($action.UUID -ne "com.codexstreamdeck.control.effort-preset") { continue }
  $effort = [string]$action.Settings.effort
  if (-not $levels.ContainsKey($effort)) { continue }

  $level = $levels[$effort]
  $actions.PSObject.Properties[$property.Name].Value =
    New-NativeEffortAction $level.title $level.steps
  $converted++
}

if ($converted -eq 0) {
  throw "The profile has no fixed effort actions to convert"
}

$backup = "$($manifest.FullName).pre-native-efforts-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
Copy-Item -LiteralPath $manifest.FullName -Destination $backup
Install-CodexKeybindings $CodexHome

$json | ConvertTo-Json -Depth 100 -Compress |
  Set-Content -LiteralPath $manifest.FullName -Encoding utf8
Get-Content -LiteralPath $manifest.FullName -Raw |
  ConvertFrom-Json -Depth 100 | Out-Null

Write-Output "Converted effort keys: $converted"
Write-Output "Profile: $($manifest.FullName)"
Write-Output "Profile backup: $backup"
Write-Output "Restart Codex once so the externally installed keybindings are loaded."
