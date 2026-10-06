# Third-party notices

- **Ollama** (MIT License) - https://github.com/ollama/ollama - bundled in the Local edition, or downloaded on request in the Cloud edition.
- **Qwen3** (Apache License 2.0) - Alibaba Cloud - downloaded through Ollama on first use.
- **whisper.cpp** (MIT) and **Piper** (MIT) - bundled speech models; see their repositories for model licenses.

Review each model's license before commercial redistribution.

## Editions

- `npm run build:cloud` - small installer; Settings > Local AI installs Ollama and qwen3:4b on demand.
- `npm run build:local` - bundles the Ollama runtime; qwen3:4b (~2.5 GB) downloads on first launch with progress shown in Settings.