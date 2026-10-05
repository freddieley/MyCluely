# Downloads the speech engines Vela bundles: whisper.cpp (STT) + ggml base.en model, Piper (TTS) + en_US-lessac-medium voice.
$ErrorActionPreference = "Stop"
$dest = Join-Path $PSScriptRoot "..\src-tauri\resources\speech"
New-Item -ItemType Directory -Force $dest | Out-Null
$tmp = Join-Path $env:TEMP "vela-speech"; New-Item -ItemType Directory -Force $tmp | Out-Null

function Get-File($url, $out) { if (-not (Test-Path $out)) { Invoke-WebRequest $url -OutFile $out -UseBasicParsing } }

$stt = Join-Path $dest "whisper"; New-Item -ItemType Directory -Force $stt | Out-Null
if (-not (Test-Path "$stt\whisper-cli.exe")) {
  Get-File "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip" "$tmp\whisper.zip"
  Expand-Archive "$tmp\whisper.zip" "$tmp\whisper" -Force
  Get-ChildItem "$tmp\whisper" -Recurse -File | Where-Object { $_.Extension -in ".exe", ".dll" -and $_.Name -notmatch "^(main|SDL2|test|wchess|whisper-(?!cli))|parakeet" } | Copy-Item -Destination $stt -Force
}
Get-File "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" "$stt\ggml-base.en.bin"

$tts = Join-Path $dest "piper"; New-Item -ItemType Directory -Force $tts | Out-Null
if (-not (Test-Path "$tts\piper.exe")) {
  Get-File "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip" "$tmp\piper.zip"
  Expand-Archive "$tmp\piper.zip" "$tmp\piper" -Force
  Copy-Item "$tmp\piper\piper\*" $tts -Recurse -Force
}
$v = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"
Get-File "$v/en_US-lessac-medium.onnx" "$tts\voice.onnx"
Get-File "$v/en_US-lessac-medium.onnx.json" "$tts\voice.onnx.json"
Write-Host "Speech assets ready in $dest"

