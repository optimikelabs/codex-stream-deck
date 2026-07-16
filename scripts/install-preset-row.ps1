param(
  [string]$ProfilesRoot = "$env:APPDATA\Elgato\StreamDeck\ProfilesV3"
)

$ErrorActionPreference = "Stop"

function New-HotkeyAction([string]$title) {
  [pscustomobject]@{
    ActionID = [guid]::NewGuid().ToString()
    LinkedTitle = $true
    Name = "Hotkey"
    Plugin = [pscustomobject]@{ Name = "Hotkey"; UUID = "com.elgato.streamdeck.system.hotkey"; Version = "1.0" }
    Settings = [pscustomobject]@{
      Coalesce = $true
      Hotkeys = @(
        [pscustomobject]@{ KeyCmd=$false; KeyCtrl=$true; KeyModifiers=3; KeyOption=$false; KeyShift=$true; NativeCode=77; QTKeyCode=77; VKeyCode=77 },
        [pscustomobject]@{ KeyCmd=$false; KeyCtrl=$false; KeyModifiers=0; KeyOption=$false; KeyShift=$false; NativeCode=146; QTKeyCode=33554431; VKeyCode=-1 },
        [pscustomobject]@{ KeyCmd=$false; KeyCtrl=$false; KeyModifiers=0; KeyOption=$false; KeyShift=$false; NativeCode=146; QTKeyCode=33554431; VKeyCode=-1 },
        [pscustomobject]@{ KeyCmd=$false; KeyCtrl=$false; KeyModifiers=0; KeyOption=$false; KeyShift=$false; NativeCode=146; QTKeyCode=33554431; VKeyCode=-1 }
      )
    }
    State = 0
    States = @([pscustomobject]@{ Title = $title })
    UUID = "com.elgato.streamdeck.system.hotkey"
  }
}

function New-PluginAction([string]$uuid, [string]$name, [hashtable]$settings) {
  [pscustomobject]@{
    ActionID = [guid]::NewGuid().ToString()
    LinkedTitle = $true
    Name = $name
    Plugin = [pscustomobject]@{ Name = "Contrôle Codex FR"; UUID = $uuid; Version = "0.2.0.0" }
    Settings = [pscustomobject]$settings
    State = 0
    States = @([pscustomobject]@{})
    UUID = $uuid
  }
}

$manifest = Get-ChildItem -LiteralPath $ProfilesRoot -Recurse -Filter manifest.json |
  Where-Object { (Get-Content -LiteralPath $_.FullName -Raw) -match 'com\.codexstreamdeck\.control\.project-slot' } |
  Select-Object -First 1
if (-not $manifest) { throw "Codex Stream Deck profile not found under $ProfilesRoot" }

$backup = "$($manifest.FullName).pre-presets-$(Get-Date -Format yyyyMMdd-HHmmss).bak"
Copy-Item -LiteralPath $manifest.FullName -Destination $backup
$json = Get-Content -LiteralPath $manifest.FullName -Raw | ConvertFrom-Json -Depth 100
$actions = $json.Controllers[0].Actions

@($actions.PSObject.Properties) |
  Where-Object { $_.Value.UUID -in @("com.codexstreamdeck.control.model-preset", "com.codexstreamdeck.control.effort-preset") } |
  ForEach-Object { $actions.PSObject.Properties.Remove($_.Name) }

$actions | Add-Member -NotePropertyName "0,3" -NotePropertyValue (New-HotkeyAction "MODÈLE") -Force
$actions | Add-Member -NotePropertyName "1,3" -NotePropertyValue (New-HotkeyAction "EFFORT") -Force
$actions | Add-Member -NotePropertyName "2,3" -NotePropertyValue (New-PluginAction "com.codexstreamdeck.control.model-preset" "Preset de modèle Codex" @{ modelAlias="auto" }) -Force
$actions | Add-Member -NotePropertyName "3,3" -NotePropertyValue (New-PluginAction "com.codexstreamdeck.control.model-preset" "Preset de modèle Codex" @{ modelAlias="sol" }) -Force
$actions | Add-Member -NotePropertyName "4,3" -NotePropertyValue (New-PluginAction "com.codexstreamdeck.control.model-preset" "Preset de modèle Codex" @{ modelAlias="terra" }) -Force
$actions | Add-Member -NotePropertyName "5,3" -NotePropertyValue (New-PluginAction "com.codexstreamdeck.control.model-preset" "Preset de modèle Codex" @{ modelAlias="luna" }) -Force
$actions | Add-Member -NotePropertyName "6,3" -NotePropertyValue (New-PluginAction "com.codexstreamdeck.control.effort-preset" "Preset d’effort Codex" @{}) -Force

$json | ConvertTo-Json -Depth 100 -Compress | Set-Content -LiteralPath $manifest.FullName -Encoding utf8
Get-Content -LiteralPath $manifest.FullName -Raw | ConvertFrom-Json -Depth 100 | Out-Null
Write-Output "Updated: $($manifest.FullName)"
Write-Output "Backup:  $backup"
