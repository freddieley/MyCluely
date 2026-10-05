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

**Full Privacy Mode** locks chat and transcription to local services. It requires a running Ollama server with a selected model and a configured `whisper.cpp` executable plus local Whisper model file. Screen images, voice, and meeting audio are not sent to OpenAI in this mode. Local transcription uses temporary audio files and removes them after each transcription attempt.

## Context and accessibility

- **Screen context** is opt-in. Start sharing and Vela captures a reduced JPEG snapshot only when you send a message.
- **Meeting transcription** is opt-in, visibly active, and uses sequential 30-second audio segments. Captured transcript stays in the app until you add it to a message.
- **Speak replies aloud** uses the speech voices available through the operating system/browser. Stop speech at any time in Settings or beside a reply.
- **Keep the Vela bar on top** is configurable and saved on this device.
- Choose Wingmate, Coach, or Direct in Settings.

## Notes

Screen capture and meeting audio availability depend on the selected display/window and operating-system capture support. A display source that does not provide an audio track cannot be used for meeting transcription. Voice transcripts are placed in the composer for review; they are not sent as chat until you press send.
