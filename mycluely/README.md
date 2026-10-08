# Cue

Cue is a floating desktop controller. Press **Ctrl/Cmd+Shift+Space** in any app to bring Cue forward and focus its message box, then type a request or start a voice note.

## Run the desktop app

```sh
npm install
npm run tauri dev
```

## AI provider

In Settings, use an OpenAI API key or select an installed Ollama model. Cue stores the OpenAI key in the operating-system credential store and migrates keys saved by earlier MyCluely and Vela releases. Cue does not send an OpenAI request until you send a message; local Ollama is started only when you choose the local provider and send a message.

The selected provider receives the conversation needed to answer your request. Screen context is optional: choose a screen when prompted, and Cue sends one reduced snapshot with that message. Cue stops screen capture after the snapshot; it does not save images to disk.

## Computer actions

Cue uses explicit local tools to launch VS Code or the system text editor, open public URLs, type text, press keys, click in a user-approved screen snapshot, and work with files under your home folder. It does not offer arbitrary shell execution. Existing files are never overwritten, sensitive credential paths are excluded from file reads, and deleting a file requires an in-app confirmation. Confirm consequential external actions before Cue submits them.

Mouse control requires screen context and is limited to the primary display. The operating system may require Accessibility/Input Monitoring permission (macOS) or an X11 session with input-injection support (Linux). When a platform or permission does not support an action, Cue reports that failure rather than claiming success.

## Voice and local inference

Voice input is transcribed in short segments and placed in the message box for review; it is not a continuous realtime conversation. On Windows, fetch the pinned speech assets with `npm run assets` before using voice or packaging. On-device chat requires Ollama and an installed model; select **Private Mode** to keep model prompts local, or **Strict Local Mode** to disable web-search tools as well.

The default global shortcut can be changed in Settings. Press **Ctrl+Shift+M** to start or stop voice input while Cue is open. Screen capture and microphone use are user initiated and visibly indicated.
