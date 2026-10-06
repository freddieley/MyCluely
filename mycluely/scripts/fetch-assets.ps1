# Fetches pinned, SHA-256-verified bundled assets listed in assets.lock.json.
# Usage: fetch-assets.ps1 [-IncludeOllama]. Exits non-zero if anything is missing or mismatched.
param([switch]$IncludeOllama)
$ErrorActionPreference = "Stop"
$lock = Get-Content (Join-Path $PSScriptRoot "assets.lock.json") -Raw | ConvertFrom-Json
$res = Join-Path $PSScriptRoot "..\src-tauri\resources"
$tmp = Join-Path $env:TEMP "vela-assets"; New-Item -ItemType Directory -Force $tmp | Out-Null

function Get-Verified($asset, $out) {
  if (-not (Test-Path $out) -or (Get-FileHash $out -Algorithm SHA256).Hash.ToLower() -ne $asset.sha256) {
    Write-Host "Downloading $($asset.url)"
    Invoke-WebRequest $asset.url -OutFile $out -UseBasicParsing
  }
  $actual = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $asset.sha256) { Remove-Item $out -Force; throw "SHA-256 mismatch for $($asset.url): expected $($asset.sha256), got $actual" }
}
function Require($path) { if (-not (Test-Path $path)) { throw "Missing required asset: $path" } }

$stt = Join-Path $res "speech\whisper"; New-Item -ItemType Directory -Force $stt | Out-Null
if (-not (Test-Path "$stt\whisper-cli.exe")) {
  Get-Verified $lock.whisper "$tmp\whisper.zip"
  Expand-Archive "$tmp\whisper.zip" "$tmp\whisper" -Force
  Get-ChildItem "$tmp\whisper" -Recurse -File | Where-Object { $_.Extension -in ".exe", ".dll" -and $_.Name -notmatch "^(main|SDL2|test|wchess|whisper-(?!cli))|parakeet" } | Copy-Item -Destination $stt -Force
}
Get-Verified $lock.whisperModel "$stt\$($lock.whisperModel.file)"

$tts = Join-Path $res "speech\piper"; New-Item -ItemType Directory -Force $tts | Out-Null
if (-not (Test-Path "$tts\piper.exe")) {
  Get-Verified $lock.piper "$tmp\piper.zip"
  Expand-Archive "$tmp\piper.zip" "$tmp\piper" -Force
  Copy-Item "$tmp\piper\piper\*" $tts -Recurse -Force
}
Get-Verified $lock.piperVoice "$tts\voice.onnx"
Get-Verified $lock.piperVoiceConfig "$tts\voice.onnx.json"
Require "$stt\whisper-cli.exe"; Require "$tts\piper.exe"

if ($IncludeOllama) {
  $oll = Join-Path $res "ollama"; New-Item -ItemType Directory -Force $oll | Out-Null
  if (-not (Test-Path "$oll\ollama.exe")) {
    Get-Verified $lock.ollama "$tmp\ollama.zip"
    Expand-Archive "$tmp\ollama.zip" $oll -Force
  }
  Require "$oll\ollama.exe"
}
Write-Host "All bundled assets present and verified."
