# Vela

Vela is a personality-led desktop assistant built with Tauri, React, and TypeScript. Its floating bar can stay above other windows, and the assistant supports cloud and local inference, voice notes, optional screen context, meeting-audio transcription, and spoken replies.

## Run locally

```powershell
npm install
npm run tauri dev
```

The global shortcut is **Ctrl+Shift+Space** on Windows and **Cmd+Shift+Space** on macOS. It starts or stops an uncapped voice-note session; audio is transcribed in sequential 30-second segments and assembled in the composer.

## Choose an AI provider

In **Settings**, choose **Cloud** to use your own OpenAI API key, or **On-device** to use an installed Ollama model. Vela stores the OpenAI key in the operating system credential store and migrates an existing MyCluely key on first use. Local model availability and speed depend on installed models and device hardware; Vela does not silently fall back to a cloud model.

**Full Privacy Mode** locks chat and transcription to local services. It requires a running Ollama server with a selected model; speech models are bundled with the app and need no setup. Screen images, voice, and meeting audio are not sent to OpenAI in this mode. Local transcription uses temporary audio files and removes them after each transcription attempt.

## Context and accessibility

- **Screen context** is opt-in. Start sharing and Vela captures a reduced JPEG snapshot only when you send a message.
- **Meeting transcription** is opt-in, visibly active, and uses sequential 30-second audio segments. Captured transcript stays in the app until you add it to a message.
- **Speak replies aloud** uses the bundled Piper voice (en_US lessac), fully on-device. The OS voice is only a fallback outside Full Privacy Mode. Stop speech at any time in Settings or beside a reply.
- **Keep the Vela bar on top** is configurable and saved on this device.
- Choose Wingmate, Coach, or Direct in Settings.

## Notes

Screen capture and meeting audio availability depend on the selected display/window and operating-system capture support. A display source that does not provide an audio track cannot be used for meeting transcription. Voice transcripts are placed in the composer for review; they are not sent as chat until you press send.

## Bundled speech models

Speech-to-text (whisper.cpp + `ggml-base.en`) and text-to-speech (Piper + en_US lessac voice) ship inside the installer, so there is nothing to configure. The binaries are not committed to git (~230 MB); before `npm run tauri build` or a dev run, fetch them once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch-speech-assets.ps1
```

The installer is therefore a few hundred MB. whisper.cpp, Whisper weights and Piper are MIT-licensed; Piper bundles espeak-ng (GPL) and the lessac voice has its own dataset licence — review them before redistributing.

## Streaming and pinning

Replies stream into the chat token by token. The pin button docks the bar to the top-centre of the current monitor (always on top); unpin to move it freely.