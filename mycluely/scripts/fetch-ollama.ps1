# Downloads the Ollama Windows runtime into src-tauri/resources/ollama for the Local edition.
$ErrorActionPreference = "Stop"
$dest = Join-Path $PSScriptRoot "..\src-tauri\resources\ollama"
if (Test-Path (Join-Path $dest "ollama.exe")) { Write-Host "Ollama already present."; exit 0 }
New-Item -ItemType Directory -Force $dest | Out-Null
$zip = Join-Path $env:TEMP "ollama-windows-amd64.zip"
Invoke-WebRequest "https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip" -OutFile $zip
Expand-Archive $zip -DestinationPath $dest -Force
Remove-Item $zip
if (-not (Test-Path (Join-Path $dest "ollama.exe"))) { throw "ollama.exe missing after extract" }
Write-Host "Ollama runtime ready."