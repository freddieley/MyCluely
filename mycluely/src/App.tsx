import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import {
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import "./App.css";

type CopilotState =
  | "idle"
  | "listening"
  | "thinking"
  | "acting"
  | "confirming"
  | "responding"
  | "error";

type AssistantPersonality =
  | "wingmate"
  | "coach"
  | "direct";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type Provider = "openai" | "local";
type LocalAiModel = { name: string; vision: boolean };
type LocalAiStatus = {
  available: boolean;
  models: LocalAiModel[];
  totalMemoryGb: number;
  cpuThreads: number;
  recommendedModel: string;
  error: string | null;
};

const DEFAULT_HOTKEY = "CommandOrControl+Shift+Space";
const HOTKEY_CHOICES = ["CommandOrControl+Shift+Space", "CommandOrControl+Alt+Space", "CommandOrControl+Shift+V", "Alt+Space"];
const SHORTCUT_GROUPS: { group: string; items: [string, string][] }[] = [
  {
    group: "Anywhere (global)",
    items: [["GLOBAL", "Summon Cue & focus the message box"]],
  },
  {
    group: "Talk to Cue",
    items: [
      ["Ctrl+L", "Open chat & focus the message box"],
      ["Enter", "Send message"],
      ["Shift+Enter", "New line"],
      ["Ctrl+Shift+N", "New conversation"],
      ["Ctrl+Shift+M", "Start/stop voice note"],
    ],
  },
  {
    group: "Context",
    items: [
      ["Ctrl+Shift+S", "Attach/detach screen"],
      ["Ctrl+Shift+E", "Start/stop meeting capture"],
      ["Ctrl+Shift+D", "Delete meeting transcript"],
    ],
  },
  {
    group: "Voice & window",
    items: [
      ["Ctrl+Shift+V", "Toggle speaking replies"],
      ["Ctrl+Shift+.", "Stop speaking"],
      ["Ctrl+Shift+P", "Pin/unpin on top"],
      ["Ctrl+J", "Expand/collapse panel"],
    ],
  },
  {
    group: "Settings & help",
    items: [
      ["Ctrl+,", "Open settings"],
      ["Ctrl+1 / 2 / 3", "Wingmate / Coach / Direct"],
      ["Ctrl+/ or F1", "Show this shortcut list"],
      ["Esc", "Close help, then settings, then panel"],
    ],
  },
];
const FALLBACK_SUGGESTIONS = [
  "Open VS Code",
  "Search the web for React docs",
  "What am I looking at?",
  "Write a note on my desktop",
  "Open my text editor",
  "Find a file in Documents",
  "Help me organize these files",
  "Type a message for me",
];

function pickFallbackSuggestions() {
  return [...FALLBACK_SUGGESTIONS].sort(() => Math.random() - 0.5).slice(0, 3);
}

function formatHotkey(shortcut: string) {
  const modifier = /Macintosh|Mac OS X/.test(navigator.userAgent) ? "⌘" : "Ctrl";
  return shortcut.replace("CommandOrControl", modifier);
}

const personalities: Record<
  AssistantPersonality,
  { label: string; description: string; ready: string }
> = {
  wingmate: {
    label: "Wingmate",
    description: "A little wit, always on your side.",
    ready: "Ready when you are.",
  },
  coach: {
    label: "Coach",
    description: "Calm, thoughtful, and in your corner.",
    ready: "Take your time.",
  },
  direct: {
    label: "Direct",
    description: "Clear, concise, straight to it.",
    ready: "Standing by.",
  },
};

function App() {
  const [copilotState, setCopilotState] =
    useState<CopilotState>("idle");

  const [microphoneLevel, setMicrophoneLevel] =
    useState(0);

  const [microphoneStatus, setMicrophoneStatus] =
    useState("Ready");

  const [settingsOpen, setSettingsOpen] =
    useState(false);

  const [shortcutsOpen, setShortcutsOpen] =
    useState(false);

  const [expanded, setExpanded] =
    useState(false);

  const [messages, setMessages] =
    useState<ChatMessage[]>([]);

  const [draft, setDraft] =
    useState("");

  const [isSending, setIsSending] =
    useState(false);

  const [isTranscribing, setIsTranscribing] =
    useState(false);

  const [webTools, setWebTools] = useState(
    () => window.localStorage.getItem("vela.webTools") !== "false",
  );
  const [toolStatus, setToolStatus] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState("");
  const [chatError, setChatError] =
    useState("");

  const [apiKeyPresent, setApiKeyPresent] =
    useState(false);

  const [apiKeyInput, setApiKeyInput] =
    useState("");

  const [credentialStatus, setCredentialStatus] =
    useState("");

  const [provider, setProvider] = useState<Provider>(() =>
    window.localStorage.getItem("vela.fullPrivacy") === "true" ||
      window.localStorage.getItem("vela.provider") === "local" ? "local" : "openai",
  );
  const [fullPrivacy, setFullPrivacy] = useState(
    () => window.localStorage.getItem("vela.fullPrivacy") === "true",
  );
  const [strictLocal, setStrictLocal] = useState(
    () => window.localStorage.getItem("vela.strictLocal") === "true",
  );
  const [hotkey, setHotkey] = useState(
    () => window.localStorage.getItem("vela.hotkey") ?? DEFAULT_HOTKEY,
  );
  const [hotkeyError, setHotkeyError] = useState("");
  const [onboarded, setOnboarded] = useState(
    () => window.localStorage.getItem("vela.onboarded") === "true",
  );
  const [recordingConsent, setRecordingConsent] = useState(
    () => window.localStorage.getItem("vela.recordingConsent") === "true",
  );
  const [consentPrompt, setConsentPrompt] = useState(false);
  const startMeetingCaptureRef = useRef<() => Promise<void>>(async () => {});
  const openPanelRef = useRef<(view: "chat" | "settings") => Promise<void>>(async () => {});
  const cancelTaskRef = useRef<() => Promise<void>>(async () => {});
  const [localAiStatus, setLocalAiStatus] = useState<LocalAiStatus | null>(null);
  const [localModel, setLocalModel] = useState(
    () => window.localStorage.getItem("vela.model") ?? "",
  );
  const [localStatusMessage, setLocalStatusMessage] = useState("");
  const [localSetup, setLocalSetup] = useState<{ bundled: boolean; installed: boolean; running: boolean; defaultModel: string; progress: { active: boolean; label: string; percent: number; error: string | null } | null } | null>(null);
  const [pullName, setPullName] = useState("");
  const [alwaysOnTop, setAlwaysOnTop] = useState(
    () => window.localStorage.getItem("vela.alwaysOnTop") !== "false",
  );
  const [speakReplies, setSpeakReplies] = useState(
    () => window.localStorage.getItem("vela.speakReplies") === "true",
  );
  const [screenSharing, setScreenSharing] = useState(false);
  const [meetingCapture, setMeetingCapture] = useState(false);
  const [meetingTranscript, setMeetingTranscript] = useState("");

  const conversationRef =
    useRef<HTMLDivElement | null>(null);

  const composerRef =
    useRef<HTMLTextAreaElement | null>(null);

  const recorderRef =
    useRef<MediaRecorder | null>(null);

  const recordedChunksRef =
    useRef<Blob[]>([]);

  const recordingTimerRef =
    useRef<number | null>(null);

  const cancelRecordingRef =
    useRef(false);

  const voiceTranscriptRef = useRef("");
  const voiceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const meetingRecorderRef = useRef<MediaRecorder | null>(null);
  const meetingSegmentTimerRef = useRef<number | null>(null);
  const meetingQueueRef = useRef<Promise<void>>(Promise.resolve());
  const meetingTranscriptRef = useRef("");
  const startMeetingSegmentRef = useRef<(() => void) | null>(null);
  const meetingCaptureRef = useRef(false);
  const providerRef = useRef(provider);
  const fullPrivacyRef = useRef(fullPrivacy);
  const apiKeyPresentRef = useRef(apiKeyPresent);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  providerRef.current = provider;
  fullPrivacyRef.current = fullPrivacy;
  apiKeyPresentRef.current = apiKeyPresent;

  const [personality, setPersonality] =
    useState<AssistantPersonality>(() => {
      const savedPersonality =
        window.localStorage.getItem("vela.personality") ??
        window.localStorage.getItem("mycluely.personality");

      return savedPersonality === "coach" ||
        savedPersonality === "direct"
        ? savedPersonality
        : "wingmate";
    });

  const audioContextRef =
    useRef<AudioContext | null>(null);

  const streamRef =
    useRef<MediaStream | null>(null);

  const animationFrameRef =
    useRef<number | null>(null);

  const microphoneLevelRef =
    useRef(0);

  const isListeningRef =
    useRef(false);

  const toLocalWav = async (audio: Blob): Promise<Blob> => {
    const decodeContext = new AudioContext();
    let decoded: AudioBuffer;
    try {
      decoded = await decodeContext.decodeAudioData(await audio.arrayBuffer());
    } finally {
      await decodeContext.close();
    }
    const sampleRate = 16_000;
    const frameCount = Math.ceil(decoded.duration * sampleRate);
    const offlineContext = new OfflineAudioContext(1, frameCount, sampleRate);
    const source = offlineContext.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineContext.destination);
    source.start(0);
    const mono = (await offlineContext.startRendering()).getChannelData(0);
    let energy = 0;
    for (let index = 0; index < mono.length; index += 1) energy += mono[index] * mono[index];
    // Silent audio makes Whisper hallucinate words, so skip it.
    if (Math.sqrt(energy / Math.max(1, mono.length)) < 0.002) return new Blob([], { type: "audio/wav" });
    const wav = new ArrayBuffer(44 + mono.length * 2);
    const header = new DataView(wav);
    const writeText = (offset: number, text: string) => {
      for (let index = 0; index < text.length; index += 1) {
        header.setUint8(offset + index, text.charCodeAt(index));
      }
    };
    writeText(0, "RIFF");
    header.setUint32(4, 36 + mono.length * 2, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, sampleRate, true);
    header.setUint32(28, sampleRate * 2, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    writeText(36, "data");
    header.setUint32(40, mono.length * 2, true);
    for (let index = 0; index < mono.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, mono[index]));
      header.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Blob([wav], { type: "audio/wav" });
  };

  const transcribeVoiceNote = (voiceNote: Blob) => {
    setIsTranscribing(true);
    setMicrophoneStatus("Transcribing…");

    const transcription = voiceQueueRef.current.then(async () => {
      const activeProvider = providerRef.current;
      const preparedAudio = activeProvider === "local"
        ? await toLocalWav(voiceNote)
        : voiceNote;
      if (preparedAudio.size === 0) return;
      const bytes = new Uint8Array(await preparedAudio.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;

      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + chunkSize),
        );
      }

      const transcript = await invoke<string>("transcribe_audio", {
        audioBase64: btoa(binary),
        mimeType: preparedAudio.type || "audio/webm",
        provider: activeProvider,
        fullPrivacy: fullPrivacyRef.current,
      });

      if (transcript.trim()) {
        voiceTranscriptRef.current = [
          voiceTranscriptRef.current,
          transcript.trim(),
        ].filter(Boolean).join(" ");
        setDraft(voiceTranscriptRef.current);
      }
    });
    voiceQueueRef.current = transcription.catch((error: unknown) => {
      console.error("Voice transcription failed:", error);
      setChatError(
        typeof error === "string" ? error : error instanceof Error
          ? error.message : "I couldn't transcribe that. Want to try again?",
      );
      setMicrophoneStatus("Transcription failed");
    }).finally(() => setIsTranscribing(false));
    return voiceQueueRef.current;
  };

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    invoke<boolean>("get_api_key_status")
      .then(setApiKeyPresent)
      .catch((error: unknown) => {
        console.error("Failed to read API key status:", error);
        setCredentialStatus("Could not check saved API key.");
      });
  }, []);

  useEffect(() => {
    if (!isTauri() || !settingsOpen || provider !== "local") return;
    invoke<LocalAiStatus>("get_local_ai_status")
      .then((status) => {
        setLocalAiStatus(status);
        setLocalModel((saved) =>
          status.models.some((model) => model.name === saved)
            ? saved
            : status.models.some((model) => model.name === status.recommendedModel)
              ? status.recommendedModel
              : status.models[0]?.name ?? "",
        );
      })
      .catch((error: unknown) => {
        console.error("Couldn't check local model availability:", error);
        setLocalStatusMessage("Couldn't check whether Ollama is running.");
      });
  }, [settingsOpen, provider]);

  useEffect(() => {
    if (!isTauri()) return;
    invoke("set_always_on_top", { enabled: alwaysOnTop }).catch((error: unknown) => {
      console.error("Couldn't apply always-on-top preference:", error);
      setLocalStatusMessage("Couldn't update the always-on-top preference.");
    });
    window.localStorage.setItem("vela.alwaysOnTop", String(alwaysOnTop));
  }, [alwaysOnTop]);

  const [suggestions] = useState<string[]>(() => pickFallbackSuggestions());
  const lastMessageCount = useRef(0);
  useEffect(() => {
    // Only jump down when a new message is added, never while a reply streams in.
    if (messages.length !== lastMessageCount.current) {
      lastMessageCount.current = messages.length;
      if (conversationRef.current) {
        conversationRef.current.scrollTop =
          conversationRef.current.scrollHeight;
      }
    }
  }, [messages.length]);

  useEffect(() => {
    if (expanded && !settingsOpen) {
      composerRef.current?.focus();
    }
  }, [expanded, settingsOpen]);

  /*
   * --------------------------------------------------------------------------
   * MICROPHONE
   * --------------------------------------------------------------------------
   */

  const startMicrophone = async () => {
    if (!isTauri()) {
      setMicrophoneStatus("Use voice input in the desktop app");
      setCopilotState("idle");
      return;
    }

    if (providerRef.current === "openai" && !apiKeyPresentRef.current) {
      setChatError("Add your OpenAI API key in Settings before recording a voice note.");
      setMicrophoneStatus("Set up your key");
      setCopilotState("idle");
      await openPanel("settings");
      return;
    }

    if (isListeningRef.current) {
      return;
    }

    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });

      streamRef.current = stream;

      const audioContext =
        new AudioContext();

      audioContextRef.current =
        audioContext;

      if (
        audioContext.state === "suspended"
      ) {
        await audioContext.resume();
      }

      const analyser =
        audioContext.createAnalyser();

      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;

      const microphone =
        audioContext.createMediaStreamSource(
          stream,
        );

      microphone.connect(analyser);

      const samples =
        new Float32Array(
          analyser.fftSize,
        );

      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ].find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recordedChunksRef.current = [];
      cancelRecordingRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        if (recordingTimerRef.current !== null) {
          window.clearTimeout(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }

        if (cancelRecordingRef.current) {
          cancelRecordingRef.current = false;
          recordedChunksRef.current = [];
          return;
        }

        const voiceNote = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        recordedChunksRef.current = [];
        if (voiceNote.size > 0) {
          void transcribeVoiceNote(voiceNote);
        } else {
          setMicrophoneStatus("No audio captured");
        }

        if (isListeningRef.current && !cancelRecordingRef.current) {
          recordedChunksRef.current = [];
          recorder.start();
          recorderRef.current = recorder;
          setMicrophoneStatus("Recording…");
          recordingTimerRef.current = window.setTimeout(() => {
            if (recorder.state === "recording") {
              recorder.stop();
            }
          }, 4_000);
        }
      };
      recorder.start();
      recorderRef.current = recorder;

      isListeningRef.current = true;

      setMicrophoneStatus(
        "Recording…",
      );
      voiceTranscriptRef.current = "";
      recordingTimerRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      }, 4_000);

      const updateMicrophone = () => {
        if (!isListeningRef.current) {
          return;
        }

        analyser.getFloatTimeDomainData(
          samples,
        );

        let sumSquares = 0;

        for (
          let i = 0;
          i < samples.length;
          i++
        ) {
          const sample = samples[i];

          sumSquares +=
            sample * sample;
        }

        const rms = Math.sqrt(
          sumSquares / samples.length,
        );

        /*
         * Convert the microphone's RMS
         * amplitude into a useful 0–1
         * visual level.
         */
        const amplified =
          Math.min(1, rms * 12);

        /*
         * Suppress tiny amounts of
         * microphone/background noise.
         */
        const noiseGate = 0.035;

        let level = 0;

        if (amplified > noiseGate) {
          level =
            (amplified - noiseGate) /
            (1 - noiseGate);
        }

        /*
         * Fast attack, slower release.
         *
         * This makes speech feel responsive
         * without making the indicator jitter.
         */
        const previous =
          microphoneLevelRef.current;

        const smoothing =
          level > previous
            ? 0.45
            : 0.18;

        const smoothed =
          previous +
          (level - previous) *
            smoothing;

        microphoneLevelRef.current =
          smoothed;

        setMicrophoneLevel(
          smoothed,
        );

        animationFrameRef.current =
          requestAnimationFrame(
            updateMicrophone,
          );
      };

      updateMicrophone();
    } catch (error) {
      console.error(
        "Failed to start microphone:",
        error,
      );

      isListeningRef.current =
        false;

      setCopilotState("idle");
      await stopMicrophone(false);

      setMicrophoneStatus(
        "Microphone unavailable",
      );

      setMicrophoneLevel(0);
      setChatError(
        "Microphone couldn't start. Check your microphone permissions and try again.",
      );
    }
  };

  const stopMicrophone = async (transcribe = true) => {
    isListeningRef.current =
      false;

    if (
      animationFrameRef.current !==
      null
    ) {
      cancelAnimationFrame(
        animationFrameRef.current,
      );

      animationFrameRef.current =
        null;
    }

    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    cancelRecordingRef.current = !transcribe;
    const recorder = recorderRef.current;
    let recorderStopped = Promise.resolve();
    if (recorder?.state === "recording") {
      recorderStopped = new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
    }

    await recorderStopped;
    if (transcribe) {
      await voiceQueueRef.current;
    }

    if (streamRef.current) {
      for (
        const track of
          streamRef.current.getTracks()
      ) {
        track.stop();
      }

      streamRef.current = null;
    }

    if (
      audioContextRef.current
    ) {
      try {
        await audioContextRef.current.close();
      } catch {
        // AudioContext was already closed.
      }

      audioContextRef.current =
        null;
    }

    microphoneLevelRef.current = 0;
    if (transcribe) {
      setMicrophoneLevel(0);
      setMicrophoneStatus("Ready");
      if (voiceTranscriptRef.current) {
        setDraft(voiceTranscriptRef.current);
        await openPanelRef.current("chat");
      }
    }
  };

  /*
   * --------------------------------------------------------------------------
   * COPILOT STATE
   * --------------------------------------------------------------------------
   */

  const toggleListening = async () => {
    if (isListeningRef.current) {
      await stopMicrophone();

      setCopilotState("idle");

      return;
    }

    setCopilotState("listening");

    await startMicrophone();
  };

  /*
   * --------------------------------------------------------------------------
   * GLOBAL HOTKEY
   * --------------------------------------------------------------------------
   */

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let mounted = true;

    const setupHotkey = async () => {
      try {
        setHotkeyError("");
        await register(
          hotkey,
          async () => {
            if (!mounted) {
              return;
            }

            await invoke("show_controller");
            await openPanel("chat");
            window.setTimeout(() => composerRef.current?.focus(), 50);
          },
        );

        } catch (error) {
        console.error("Failed to register Cue hotkey:", error);
        if (mounted) {
          setHotkeyError(`Cue couldn't claim ${hotkey}. Another app may be using it. Pick a different shortcut in Settings.`);
        }
      }
    };

    setupHotkey();

    return () => {
      mounted = false;

      unregister(hotkey).catch(
        (error) => {
          console.error(
            "Failed to unregister Cue hotkey:",
            error,
          );
        },
      );

    };
  }, [hotkey]);

  useEffect(() => () => {
    void stopMicrophone(false);
  }, []);

  /*
   * --------------------------------------------------------------------------
   * WINDOW CONTROLS
   * --------------------------------------------------------------------------
   */

  const startWindowDrag = async () => {
    if (!isTauri()) {
      return;
    }

    try {
      await invoke(
        "start_window_drag",
      );
    } catch (error) {
      console.error(
        "Failed to drag window:",
        error,
      );
    }
  };

  const closeWindow = async () => {
    if (!isTauri()) {
      return;
    }

    try {
      await invoke(
        "close_window",
      );
    } catch (error) {
      console.error(
        "Failed to close window:",
        error,
      );
    }
  };

  const selectPersonality = (
    nextPersonality: AssistantPersonality,
  ) => {
    setPersonality(nextPersonality);
    window.localStorage.setItem("vela.personality", nextPersonality);
  };

  const openPanel = async (view: "chat" | "settings") => {
    setSettingsOpen(view === "settings");

    try {
      if (isTauri()) {
        await invoke("set_window_expanded", { expanded: true });
      }

      setExpanded(true);
    } catch (error) {
      console.error("Failed to expand Cue:", error);
      setChatError("Couldn't open the assistant panel. Try again.");
    }
  };
  openPanelRef.current = openPanel;

  const collapsePanel = async () => {
    try {
      if (isTauri()) {
        await invoke("set_window_expanded", { expanded: false });
      }

      setExpanded(false);
      setSettingsOpen(false);
      setChatError("");
    } catch (error) {
      console.error("Failed to collapse Cue:", error);
      setChatError("Couldn't close the assistant panel. Try again.");
    }
  };

  const shortcutHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  shortcutHandlerRef.current = (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;

    if (key === "Escape") {
      if (isSending) void cancelTaskRef.current();
      else if (shortcutsOpen) setShortcutsOpen(false);
      else if (settingsOpen) void openPanel("chat");
      else if (expanded) void collapsePanel();
      return;
    }
    if (key === "F1" || (mod && key === "/")) {
      event.preventDefault();
      setShortcutsOpen((value) => !value);
      return;
    }
    if (!mod) return;

    const code = event.code;
    const run = (action: () => void) => {
      event.preventDefault();
      action();
    };

    if (event.shiftKey) {
      if (code === "KeyM") run(() => void toggleListening());
      else if (code === "KeyS") run(() => (screenSharing ? stopScreenContext() : void captureScreen()));
      else if (code === "KeyE") run(() => (meetingCapture ? stopMeetingCapture() : void startMeetingCapture()));
      else if (code === "KeyD") run(() => { meetingTranscriptRef.current = ""; setMeetingTranscript(""); });
      else if (code === "KeyN") run(() => { setMessages([]); setChatError(""); });
      else if (code === "KeyP") run(() => setAlwaysOnTop((value) => !value));
      else if (code === "KeyV") run(() => {
        const next = !speakReplies;
        setSpeakReplies(next);
        window.localStorage.setItem("vela.speakReplies", String(next));
        if (!next) window.speechSynthesis?.cancel();
      });
      else if (code === "Period") run(() => window.speechSynthesis?.cancel());
      return;
    }

    if (code === "KeyL") run(() => { void openPanel("chat").then(() => setTimeout(() => composerRef.current?.focus(), 50)); });
    else if (code === "KeyJ") run(() => void (expanded ? collapsePanel() : openPanel("chat")));
    else if (code === "Comma") run(() => void openPanel("settings"));
    else if (code === "Digit1") run(() => selectPersonality("wingmate"));
    else if (code === "Digit2") run(() => selectPersonality("coach"));
    else if (code === "Digit3") run(() => selectPersonality("direct"));
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutHandlerRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const saveApiKey = async () => {
    const apiKey = apiKeyInput.trim();
    if (!apiKey) {
      setCredentialStatus("Paste your OpenAI API key first.");
      return;
    }

    if (!isTauri()) {
      setCredentialStatus("Save your API key from the Cue desktop app.");
      return;
    }

    setCredentialStatus("");
    try {
      await invoke("save_api_key", { apiKey });
      setApiKeyPresent(true);
      setApiKeyInput("");
      setCredentialStatus("Saved securely in your system credential store.");
    } catch (error) {
      console.error("Failed to save API key:", error);
      setCredentialStatus(
        typeof error === "string" ? error : "Couldn't save the API key.",
      );
    }
  };

  const removeApiKey = async () => {
    if (!isTauri()) {
      setCredentialStatus("Manage your API key from the Cue desktop app.");
      return;
    }

    try {
      await invoke("delete_api_key");
      setApiKeyPresent(false);
      setCredentialStatus("API key removed from your system keychain.");
    } catch (error) {
      console.error("Failed to remove API key:", error);
      setCredentialStatus("Couldn't remove the API key.");
    }
  };

  const refreshLocalModels = async () => {
    try {
      const status = await invoke<LocalAiStatus>("get_local_ai_status");
      setLocalAiStatus(status);
      if (!status.models.some((model) => model.name === localModel)) {
        setLocalModel(status.models[0]?.name ?? "");
      }
      setLocalStatusMessage(status.available
        ? `${status.models.length} local model${status.models.length === 1 ? "" : "s"} found.`
        : status.error ?? "Ollama isn't running.");
    } catch (error) {
      console.error("Couldn't refresh Ollama models:", error);
      setLocalStatusMessage(typeof error === "string" ? error : "Couldn't refresh local models.");
    }
  };

  const setupBusy = Boolean(localSetup?.progress?.active);
  useEffect(() => {
    if (!isTauri() || !settingsOpen || provider !== "local") return;
    let stop = false;
    let wasActive = setupBusy;
    const tick = async () => {
      try {
        const setup = await invoke<NonNullable<typeof localSetup>>("get_local_ai_setup");
        if (stop) return;
        setLocalSetup(setup);
        const active = Boolean(setup.progress?.active);
        if (wasActive && !active) void refreshLocalModelsRef.current();
        wasActive = active;
      } catch { /* ignore */ }
    };
    void tick();
    if (!setupBusy) return () => { stop = true; };
    const id = window.setInterval(() => void tick(), 5000);
    return () => { stop = true; window.clearInterval(id); };
  }, [settingsOpen, provider, setupBusy]);

  const refreshLocalModelsRef = useRef<() => Promise<void>>(async () => {});

  const startLocalAction = async (command: string, args?: Record<string, unknown>) => {
    const isSetupAction = command === "install_local_ai" || command === "pull_model";
    if (isSetupAction) {
      setLocalSetup((current) => current ? {
        ...current,
        progress: { active: true, label: "Starting", percent: -1, error: null },
      } : current);
    }
    try {
      await invoke(command, args);
      setLocalStatusMessage("");
    } catch (error) {
      const message = typeof error === "string" ? error : "That didn't work.";
      setLocalStatusMessage(message);
      if (isSetupAction) {
        setLocalSetup((current) => current ? {
          ...current,
          progress: { active: false, label: "", percent: 100, error: message },
        } : current);
      }
    }
  };

  const removeModel = async (name: string) => {
    try {
      await invoke("delete_model", { name });
      await refreshLocalModels();
    } catch (error) {
      setLocalStatusMessage(typeof error === "string" ? error : "Couldn't delete that model.");
    }
  };

  refreshLocalModelsRef.current = refreshLocalModels;

  const chooseProvider = (nextProvider: Provider) => {
    setProvider(nextProvider);
    window.localStorage.setItem("vela.provider", nextProvider);
    if (nextProvider === "openai" && fullPrivacy) {
      setFullPrivacy(false);
      window.localStorage.setItem("vela.fullPrivacy", "false");
    }
  };

  const chooseStrictLocal = (enabled: boolean) => {
    setStrictLocal(enabled);
    window.localStorage.setItem("vela.strictLocal", String(enabled));
    if (enabled && !fullPrivacy) choosePrivacyMode(true);
  };

  const choosePrivacyMode = (enabled: boolean) => {
    if (!enabled && strictLocal) {
      setStrictLocal(false);
      window.localStorage.setItem("vela.strictLocal", "false");
    }
    setFullPrivacy(enabled);
    window.localStorage.setItem("vela.fullPrivacy", String(enabled));
    if (enabled) {
      setProvider("local");
      window.localStorage.setItem("vela.provider", "local");
    }
  };

  const captureScreen = async () => {
    if (!isTauri() || screenSharing) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current = stream;
      if (screenVideoRef.current) screenVideoRef.current.srcObject = stream;
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setScreenSharing(false);
        screenStreamRef.current = null;
      }, { once: true });
      setScreenSharing(true);
    } catch (error) {
      console.error("Screen sharing was not started:", error);
      setChatError("Screen context wasn't started. Choose a screen or window in the share prompt.");
    }
  };

  const stopScreenContext = () => {
    setScreenSharing(false);
    screenStreamRef.current?.getVideoTracks().forEach((track) => track.stop());
    if (!meetingCaptureRef.current) {
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    }
  };

  const startMeetingSegment = () => {
    const stream = screenStreamRef.current;
    const audioTracks = stream?.getAudioTracks() ?? [];
    if (!meetingCaptureRef.current || audioTracks.length === 0) return;
    const audioStream = new MediaStream(audioTracks);
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      .find((candidate) => MediaRecorder.isTypeSupported(candidate));
    const recorder = mimeType
      ? new MediaRecorder(audioStream, { mimeType })
      : new MediaRecorder(audioStream);
    meetingRecorderRef.current = recorder;
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      meetingRecorderRef.current = null;
      if (meetingSegmentTimerRef.current !== null) {
        window.clearTimeout(meetingSegmentTimerRef.current);
        meetingSegmentTimerRef.current = null;
      }
      const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (audio.size > 0) {
        meetingQueueRef.current = meetingQueueRef.current.then(async () => {
          const activeProvider = providerRef.current;
          const preparedAudio = activeProvider === "local"
            ? await toLocalWav(audio)
            : audio;
          if (preparedAudio.size === 0) return;
          const bytes = new Uint8Array(await preparedAudio.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          }
          const transcript = await invoke<string>("transcribe_audio", {
            audioBase64: btoa(binary),
            mimeType: preparedAudio.type || "audio/webm",
            provider: activeProvider,
            fullPrivacy: fullPrivacyRef.current,
          });
          if (transcript.trim()) {
            meetingTranscriptRef.current += `${meetingTranscriptRef.current ? "\n" : ""}${transcript.trim()}`;
            setMeetingTranscript(meetingTranscriptRef.current);
          }
        }).catch((error: unknown) => {
          console.error("Meeting transcription failed:", error);
          setChatError(typeof error === "string" ? error : "Couldn't transcribe meeting audio.");
        });
      }
      if (meetingCaptureRef.current) startMeetingSegmentRef.current?.();
    };
    recorder.start();
    meetingRecorderRef.current = recorder;
    meetingSegmentTimerRef.current = window.setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 4_000);
  };

  startMeetingSegmentRef.current = startMeetingSegment;

  const startMeetingCapture = async () => {
    if (!isTauri() || meetingCapture) return;
    if (!recordingConsent) {
      setConsentPrompt(true);
      return;
    }
    if (provider === "openai" && !apiKeyPresent) {
      setChatError("Add your OpenAI API key in Settings before transcribing a meeting.");
      return;
    }
    try {
      if (screenSharing) stopScreenContext();
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("The selected screen source doesn't provide audio. Choose a meeting window or system-audio source.");
      }
      screenStreamRef.current = stream;
      if (screenVideoRef.current) screenVideoRef.current.srcObject = stream;
      meetingTranscriptRef.current = "";
      setMeetingTranscript("");
      meetingCaptureRef.current = true;
      setMeetingCapture(true);
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setScreenSharing(false);
        stopMeetingCapture();
      }, { once: true });
      startMeetingSegment();
    } catch (error) {
      console.error("Meeting capture was not started:", error);
      setChatError(error instanceof Error ? error.message : "Meeting audio capture wasn't started.");
    }
  };

  const stopMeetingCapture = () => {
    meetingCaptureRef.current = false;
    setMeetingCapture(false);
    const recorder = meetingRecorderRef.current;
    if (meetingSegmentTimerRef.current !== null) {
      window.clearTimeout(meetingSegmentTimerRef.current);
      meetingSegmentTimerRef.current = null;
    }
    if (recorder?.state === "recording") recorder.stop();
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    setScreenSharing(false);
    if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    setMicrophoneStatus("Ready");
  };

  const snapshotScreen = async () => {
    if (!screenSharing || !screenVideoRef.current) {
      return { image: undefined, width: 0, height: 0 };
    }
    const video = screenVideoRef.current;
    await new Promise<void>((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) resolve();
      else video.addEventListener("loadeddata", () => resolve(), { once: true });
    });
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return { image: undefined, width: 0, height: 0 };
    const scale = Math.min(1, 1280 / width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL("image/jpeg", 0.65).split(",", 2)[1];
    return { image: jpeg, width, height };
  };

  const speakText = async (rawText: string) => {
    if (!speakReplies) return;
    const text = rawText
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, "")
      .replace(/[*_~|]+/g, "")
      .trim();
    if (!text) return;
    try {
      if (ttsAudioRef.current) ttsAudioRef.current.pause();
      const wav = await invoke<string>("synthesize_speech", { text });
      const audio = new Audio(`data:audio/wav;base64,${wav}`);
      ttsAudioRef.current = audio;
      await audio.play();
      return;
    } catch (error) {
      console.error("Bundled voice failed:", error);
    }
    if (fullPrivacyRef.current || !("speechSynthesis" in window)) {
      setChatError("Cue's built-in voice couldn't play this reply.");
      return;
    }
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  };

  const cancelCurrentTask = async () => {
    setPendingConfirmation("");
    setToolStatus("");
    try {
      await invoke("cancel_active_task");
    } catch (error) {
      console.error("Couldn't cancel Cue's task:", error);
    }
  };
  cancelTaskRef.current = cancelCurrentTask;

  const answerConfirmation = async (approved: boolean) => {
    setPendingConfirmation("");
    setCopilotState(approved ? "acting" : "thinking");
    try {
      await invoke("respond_to_confirmation", { approved });
    } catch (error) {
      setChatError(typeof error === "string" ? error : "That confirmation is no longer active.");
    }
  };

  const sendMessage = async (messageText: string) => {
    const content = messageText.trim();
    if (!content || isSending) {
      return;
    }

    if (!isTauri()) {
      setChatError("Chat is available in the Cue desktop app.");
      return;
    }

    if (provider === "openai" && !apiKeyPresent) {
      setChatError("Add your OpenAI API key in settings to start chatting.");
      return;
    }
    if (provider === "local" && !localModel) {
      setChatError("Start Ollama and install a model, then refresh local models in settings.");
      return;
    }

    const nextMessages = [
      ...messages,
      { role: "user" as const, content },
    ];
    setMessages(nextMessages);
    setDraft("");
    setChatError("");
    setIsSending(true);
    setCopilotState("thinking");

    let failed = false;
    try {
      const screen = await snapshotScreen();
      const stream = new Channel<string>();
      let streamed = "";
      setMessages([...nextMessages, { role: "assistant", content: "" }]);
      const toolChannel = new Channel<string>();
      toolChannel.onmessage = (label) => {
        if (label === "CAPTURE_SCREEN") {
          void snapshotScreen().then(async (capture) => {
            if (!capture.image) throw new Error("Share a screen with Cue before asking it to inspect the screen.");
            await invoke("update_task_screen", {
              screenImage: capture.image,
              screenWidth: capture.width,
              screenHeight: capture.height,
            });
          }).catch((error: unknown) => {
            setChatError(typeof error === "string" ? error : error instanceof Error ? error.message : "Couldn't refresh screen context.");
          });
          return;
        }
        if (label.startsWith("CONFIRM: ")) {
          setPendingConfirmation(label.slice("CONFIRM: ".length));
          setToolStatus("");
          setCopilotState("confirming");
        } else {
          setToolStatus(label);
          setCopilotState("acting");
        }
      };
      stream.onmessage = (delta) => {
        setToolStatus("");
        setCopilotState("responding");
        streamed += delta;
        const snapshot = streamed;
        setMessages([...nextMessages, { role: "assistant", content: snapshot }]);
      };
      const reply = await invoke<string>("send_chat_message", {
        messages: nextMessages.slice(-8),
        personality,
        provider,
        model: localModel,
        fullPrivacy,
        screenImage: screen.image ?? null,
        screenWidth: screen.width,
        screenHeight: screen.height,
        webTools: webTools && !strictLocal,
        strictLocal,
        onDelta: stream,
        onTool: toolChannel,
      });
      setMessages([
        ...nextMessages,
        { role: "assistant", content: reply },
      ]);
      speakText(reply);
    } catch (error) {
      failed = true;
      console.error("Assistant request failed:", error);
      setMessages(nextMessages.slice(0, -1));
      setDraft(content);
      setChatError(
        typeof error === "string"
          ? error
          : "I couldn't reach my brain just now. Give it another try.",
      );
    } finally {
      setIsSending(false);
      setToolStatus("");
      setPendingConfirmation("");
      if (screenSharing) stopScreenContext();
      setCopilotState(failed ? "error" : "idle");
    }
  };

  /*
   * --------------------------------------------------------------------------
   * VISUAL STATE
   * --------------------------------------------------------------------------
   */

  const level = microphoneLevel;

  const stateLabel =
    meetingCapture
      ? "Meeting live"
      : copilotState === "idle"
      ? microphoneStatus === "Ready"
        ? personalities[personality].ready
        : microphoneStatus
      : copilotState === "listening"
        ? microphoneStatus
        : copilotState === "thinking"
          ? "Thinking"
          : copilotState === "acting"
            ? toolStatus || "Operating your computer"
            : copilotState === "confirming"
              ? "Waiting for your approval"
              : copilotState === "error"
                ? "Something went wrong"
                : "Responding";

  startMeetingCaptureRef.current = startMeetingCapture;
  const recordingActive = copilotState === "listening" || meetingCapture;

  return (
    <main
      className={`app-shell${expanded ? " expanded" : ""}`}
      style={
        {
          "--mic-level": level,
        } as React.CSSProperties
      }
    >
      <section
        className={`copilot-bar state-${copilotState}`}
        data-personality={personality}
      >
        <div
          className="copilot-drag-region"
          onMouseDown={(event) => {
            if (event.button === 0) {
              void startWindowDrag();
            }
          }}
        >
          <div className="copilot-brand">
            <img className="brand-mark" src="/vela-mark.svg" alt="" />

            <span className="brand-name">
              Cue
            </span>
          </div>

          <div className="copilot-status" role="status" aria-live="polite">
              <div
                className="state-indicator"
                role={copilotState === "listening" ? "img" : undefined}
                aria-label={
                  copilotState === "listening"
                    ? `Microphone level ${Math.round(level * 100)}%`
                    : undefined
                }
              >
                {copilotState === "listening" &&
                  [1, 0.72, 1.25, 0.88, 0.62].map(
                    (scale, index) => (
                      <span
                        key={index}
                        style={{
                          transform: `scaleY(${Math.max(
                            0.08,
                            level * scale,
                          )})`,
                          opacity: 0.55 + level * 0.45,
                        }}
                        aria-hidden="true"
                      />
                    ),
                  )}

                {copilotState === "thinking" && (
                  <div className="thinking-spinner" />
                )}

                {copilotState === "responding" && (
                  <div className="responding-pulse" />
                )}

                {copilotState === "acting" && (
                  <div className="acting-pulse" />
                )}

                {copilotState === "confirming" && (
                  <div className="confirm-indicator">!</div>
                )}

                {(copilotState === "idle" || copilotState === "error") && (
                  <div
                    className={
                      copilotState === "error"
                        ? "error-dot"
                        : meetingCapture
                        ? "recording-dot"
                        : microphoneStatus === "Microphone unavailable"
                        ? "error-dot"
                        : "idle-dot"
                    }
                  />
                )}
              </div>

              <span>{stateLabel}</span>
          </div>
        </div>

        <div
          className="copilot-actions"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            className={`icon-button${alwaysOnTop ? " active" : ""}`}
            onClick={() => setAlwaysOnTop((value) => !value)}
            aria-label={alwaysOnTop ? "Unlock Cue from the top of the screen" : "Keep Cue on top of the screen"}
            aria-pressed={alwaysOnTop}
            title={alwaysOnTop ? "Pinned above other windows" : "Keep on top"}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 4h8l-1 6 3 3v2H6v-2l3-3-1-6Zm4 11v5" />
            </svg>
          </button>

          <button
            type="button"
            className={`icon-button microphone-button${
              copilotState === "listening" ? " active" : ""
            }`}
            onClick={() => void toggleListening()}
            aria-label={
              copilotState === "listening"
                ? "Stop voice recording"
                : "Record a voice message"
            }
            aria-pressed={copilotState === "listening"}
            title={
              copilotState === "listening"
                ? "Stop recording to transcribe your voice note"
                : "Record a voice message (Ctrl+Shift+M)"
            }
            disabled={isTranscribing}
          >
            {copilotState === "listening" ? (
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="3" width="6" height="12" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" />
              </svg>
            )}
          </button>

          {isSending && (
            <button
              type="button"
              className="icon-button stop-task-button"
              onClick={() => void cancelCurrentTask()}
              aria-label="Stop Cue's current task"
              title="Stop task"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          )}

          <button
            type="button"
            className={`icon-button${settingsOpen ? " active" : ""}`}
            onClick={() => void openPanel("settings")}
            aria-label="Settings"
            aria-expanded={settingsOpen}
            title="Assistant settings"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1.5 1.6v.1h-2.5v-.1a1.7 1.7 0 0 0-1.5-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1.5H5.3v-2.5h.1a1.7 1.7 0 0 0 1.6-1.5 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1.5-1.6V5.3h2.5v.1a1.7 1.7 0 0 0 1.5 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1.5h.1v2.5h-.1a1.7 1.7 0 0 0-1.6 1.5Z" />
            </svg>
          </button>

          {expanded ? (
            <button
              type="button"
              className="icon-button panel-toggle"
              onClick={() => void collapsePanel()}
              aria-label="Collapse assistant"
              title="Collapse"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="m6 14 6-6 6 6" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="icon-button panel-toggle"
              onClick={() => void openPanel("chat")}
              aria-label="Open assistant chat"
              title="Open chat"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 8 8 0 0 1-3.4-.8L4 20l1.8-4.1a7.3 7.3 0 0 1-1-3.9A7.5 7.5 0 0 1 12.3 4h.2a7.5 7.5 0 0 1 7.5 7.5Z" />
              </svg>
            </button>
          )}

          <button
            type="button"
            className="icon-button close-button"
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();

              void closeWindow();
            }}
            aria-label="Close"
          >
            <span />
            <span />
          </button>
        </div>
      </section>

      {recordingActive && (
        <div className="recording-banner" role="status">
          <span className="rec-dot" aria-hidden="true" />
          <strong>RECORDING</strong>
          <span>{meetingCapture ? "Capturing meeting audio. Use Stop capture to end it." : `Listening to your microphone. Press ${formatHotkey(hotkey)} to stop.`}</span>
        </div>
      )}
      {pendingConfirmation && (
        <div className="confirmation-overlay" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title">
          <section className="confirmation-card">
            <div className="eyebrow">YOUR APPROVAL</div>
            <h2 id="confirmation-title">Cue needs your confirmation</h2>
            <p>{pendingConfirmation}</p>
            <div className="confirmation-actions">
              <button type="button" className="remove-key-button" onClick={() => void answerConfirmation(false)}>Cancel</button>
              <button type="button" className="save-key-button" onClick={() => void answerConfirmation(true)}>Approve</button>
            </div>
          </section>
        </div>
      )}
      {expanded && !onboarded && (
        <section className="assistant-panel" aria-label="Welcome to Cue">
          <div className="settings-page onboarding">
            <div className="panel-heading">
              <div className="eyebrow">WELCOME</div>
              <h1>Meet Cue.</h1>
              <p>Control your computer with your voice or a quick message.</p>
            </div>
            <div className="provider-card">
              <p className="provider-copy"><strong>Summon Cue:</strong> press <kbd>{formatHotkey(hotkey)}</kbd> from any app to open Cue and focus the message box. Turn on the microphone when you want to speak.</p>
              <p className="provider-copy">Cue uses your OpenAI API key or an on-device Ollama model. Your key is stored in the system credential store; relevant messages and optional screen snapshots are sent to the selected provider.</p>
              {!apiKeyPresent && provider === "openai" && (
                <div className="key-entry">
                  <input type="password" autoComplete="new-password" value={apiKeyInput} onChange={(event) => setApiKeyInput(event.target.value)} placeholder="OpenAI API key" aria-label="OpenAI API key" />
                  <button type="button" className="save-key-button" onClick={() => void saveApiKey()}>Save key</button>
                </div>
              )}
              {credentialStatus && <p className="credential-status" role="status">{credentialStatus}</p>}
              {hotkeyError && <p className="credential-status" role="alert">{hotkeyError}</p>}
            </div>
            <button type="button" className="back-to-chat" onClick={() => { window.localStorage.setItem("vela.onboarded", "true"); setOnboarded(true); }}>
              Got it <span aria-hidden="true">&rarr;</span>
            </button>
          </div>
        </section>
      )}
      {consentPrompt && (
        <div className="shortcuts-overlay" role="dialog" aria-label="Recording consent" onClick={() => setConsentPrompt(false)}>
          <div className="shortcuts-card" onClick={(event) => event.stopPropagation()}>
            <div className="shortcuts-head"><strong>Before you record a meeting</strong></div>
            <p className="provider-copy">Recording or transcribing other people may require their consent where you live. You are responsible for informing participants and following local law and your organization's policies. Cue does not store audio; transcripts stay in this session unless you keep them.</p>
            <div className="key-entry">
              <button type="button" className="save-key-button" onClick={() => {
                window.localStorage.setItem("vela.recordingConsent", "true");
                setRecordingConsent(true);
                setConsentPrompt(false);
                window.setTimeout(() => void startMeetingCaptureRef.current(), 0);
              }}>I understand, start</button>
              <button type="button" className="remove-key-button" onClick={() => setConsentPrompt(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {expanded && onboarded && (
        <section className="assistant-panel" aria-label="Cue assistant">
          {settingsOpen ? (
            <div className="settings-page">
              <div className="panel-heading">
                <div className="eyebrow">THE VIBE</div>
                <h1>Make me yours.</h1>
                <p>Same sharp brain, tuned to your wavelength.</p>
              </div>

              <div className="personality-cards" role="group" aria-label="Assistant personality">
                {(Object.keys(personalities) as AssistantPersonality[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`personality-card${personality === option ? " selected" : ""}`}
                    onClick={() => selectPersonality(option)}
                    aria-pressed={personality === option}
                  >
                    <span className={`personality-orb ${option}`} />
                    <span className="card-title">{personalities[option].label}</span>
                    <span className="card-description">{personalities[option].description}</span>
                  </button>
                ))}
              </div>

              <div className="provider-card">
                <div className="provider-title">
                  <div>
                    <div className="eyebrow">YOUR PRIVACY, YOUR CALL</div>
                    <h2>Choose where Cue thinks</h2>
                  </div>
                </div>
                <div className="provider-choice" role="group" aria-label="AI provider">
                  <button type="button" className={provider === "openai" ? "selected" : ""} onClick={() => chooseProvider("openai")} aria-pressed={provider === "openai"}>
                    <strong>Cloud</strong><span>OpenAI API</span>
                  </button>
                  <button type="button" className={provider === "local" ? "selected" : ""} onClick={() => chooseProvider("local")} aria-pressed={provider === "local"}>
                    <strong>On-device AI</strong><span>Ollama</span>
                  </button>
                </div>
                <label className="privacy-toggle">
                  <input type="checkbox" checked={fullPrivacy} onChange={(event) => choosePrivacyMode(event.target.checked)} />
                  <span><strong>Private Mode</strong><small>Chat and transcription run on this device (no cloud AI). If web access is on, search queries and page requests still go to the internet.</small></span>
                </label>
                <label className="privacy-toggle">
                  <input type="checkbox" checked={strictLocal} onChange={(event) => chooseStrictLocal(event.target.checked)} />
                  <span><strong>Strict Local Mode</strong><small>Private Mode plus no web access. Cue's AI features send nothing over the network.</small></span>
                </label>
                {provider === "local" && (
                  <div className="local-model-setup">
                    <div className="local-model-row">
                      <label htmlFor="local-model">On-device model</label>
                      <select id="local-model" value={localModel} onChange={(event) => {
                        setLocalModel(event.target.value);
                        window.localStorage.setItem("vela.model", event.target.value);
                      }} disabled={!localAiStatus?.models.length}>
                        {localAiStatus?.models.length
                          ? localAiStatus.models.map((model) => <option key={model.name} value={model.name}>{model.name}{model.vision ? " · vision" : ""}</option>)
                          : <option value="">No Ollama models found</option>}
                      </select>
                      <button type="button" className="save-key-button" onClick={() => void refreshLocalModels()}>Refresh</button>
                    </div>
                    <p className="provider-copy">
                      {localAiStatus?.available
                        ? `${localAiStatus.totalMemoryGb} GB RAM · ${localAiStatus.cpuThreads} CPU threads · Suggested: ${localAiStatus.recommendedModel}. Actual speed depends on your hardware.`
                        : "Install and start Ollama, then pull a model such as qwen3:4b. Cue will never silently fall back to the cloud."}
                    </p>
                  </div>
                )}
                <div className="local-model-setup">
                  {localSetup && !localSetup.installed && !localSetup.running && (
                    <>
                      <p className="provider-copy">Run Cue on this PC: install the on-device AI engine and {localSetup.defaultModel} (about 2.5 GB download).</p>
                      <button type="button" className="save-key-button" disabled={Boolean(localSetup.progress?.active)} onClick={() => void startLocalAction("install_local_ai")}>Install On-device AI</button>
                    </>
                  )}
                  {localSetup?.progress?.active && (
                    <p className="provider-copy" role="status">
                      {localSetup.progress.label}{localSetup.progress.percent >= 0 ? ` - ${Math.round(localSetup.progress.percent)}%` : "..."}
                    </p>
                  )}
                  {localSetup?.progress?.error && !localSetup.progress.active && <p className="credential-status" role="alert">{localSetup.progress.error}</p>}
                  {(localSetup?.installed || localSetup?.running) && (
                    <>
                      <div className="key-entry">
                        <input type="text" placeholder="Get a model, e.g. llama3.2:3b" value={pullName} onChange={(event) => setPullName(event.target.value)} />
                        <button type="button" className="save-key-button" disabled={!pullName.trim() || Boolean(localSetup?.progress?.active)} onClick={() => { void startLocalAction("pull_model", { name: pullName.trim() }); setPullName(""); }}>Install</button>
                      </div>
                      <div className="model-list">{localAiStatus?.models.map((model) => (
                        <div className="model-item" key={model.name}>
                          <span>{model.name}{model.vision ? " · vision" : ""}</span>
                          <button type="button" className="remove-key-button" onClick={() => void removeModel(model.name)}>Delete</button>
                        </div>
                      ))}</div>
                    </>
                  )}
                </div>                {localStatusMessage && <p className="credential-status" role="status">{localStatusMessage}</p>}
              </div>

              <div className="provider-card">
                <div className="provider-title">
                  <div>
                    <div className="eyebrow">CLOUD PROVIDER</div>
                    <h2>OpenAI API key</h2>
                  </div>
                  <span className={`key-status${apiKeyPresent ? " connected" : ""}`}>
                    <span />
                    {apiKeyPresent ? "Connected" : "Not connected"}
                  </span>
                </div>
                <p className="provider-copy">Your key stays in your system credential store. Cloud chat and transcription are sent to OpenAI only when Cloud is selected. If you turn on screen context in Cloud mode, one screenshot is sent with your message. Cue never saves screenshots to disk.</p>
                <div className="key-entry">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={apiKeyInput}
                    onChange={(event) => setApiKeyInput(event.target.value)}
                    placeholder={apiKeyPresent ? "Enter a new key to replace it" : "sk-..."}
                    aria-label="OpenAI API key"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveApiKey();
                      }
                    }}
                  />
                  <button type="button" className="save-key-button" onClick={() => void saveApiKey()}>
                    Save key
                  </button>
                  {apiKeyPresent && (
                    <button type="button" className="remove-key-button" onClick={() => void removeApiKey()}>
                      Remove
                    </button>
                  )}
                </div>
                <div className="provider-card feature-settings">
                  <div className="eyebrow">YOUR FLOW</div>
                  <div className="hotkey-row">
                    <label htmlFor="hotkey-select"><strong>Summon Cue shortcut</strong></label>
                    <select id="hotkey-select" value={hotkey} onChange={(event) => {
                      setHotkey(event.target.value);
                      window.localStorage.setItem("vela.hotkey", event.target.value);
                    }}>
                      {HOTKEY_CHOICES.map((choice) => <option key={choice} value={choice}>{formatHotkey(choice)}</option>)}
                    </select>
                  </div>
                  {hotkeyError && <p className="credential-status" role="alert">{hotkeyError}</p>}
                  <label className="privacy-toggle">
                    <input type="checkbox" checked={alwaysOnTop} onChange={(event) => setAlwaysOnTop(event.target.checked)} />
                    <span><strong>Keep the Cue bar on top</strong><small>Pin the floating assistant above other windows.</small></span>
                  </label>
                  <label className="privacy-toggle">
                    <input type="checkbox" checked={speakReplies} onChange={(event) => {
                      setSpeakReplies(event.target.checked);
                      window.localStorage.setItem("vela.speakReplies", String(event.target.checked));
                      if (!event.target.checked) window.speechSynthesis?.cancel();
                    }} />
                    <span><strong>Speak replies aloud</strong><small>Uses system voices. Private Mode only uses voices marked local by your system. Use Stop speaking to silence a reply.</small></span>
                  </label>
                  <label className="privacy-toggle">
                    <input type="checkbox" checked={webTools && !strictLocal} disabled={strictLocal} onChange={(event) => {
                      setWebTools(event.target.checked);
                      window.localStorage.setItem("vela.webTools", String(event.target.checked));
                    }} />
                    <span><strong>Web access</strong><small>{strictLocal ? "Disabled by Strict Local Mode." : fullPrivacy ? "The model stays on this device, but search queries and page requests are sent to the websites involved." : "Lets Cue search the web and browse pages in a real headless browser, following links like a person."}</small></span>
                  </label>
                  <button type="button" className="remove-key-button" onClick={() => window.speechSynthesis?.cancel()}>Stop speaking</button>
                </div>
                {credentialStatus && (
                  <p className="credential-status" role="status">{credentialStatus}</p>
                )}
              </div>
              <p className="provider-copy">Screen context is captured only after you choose a screen and is attached only when you send a message. Snapshots aren't saved to disk.</p>
              <button type="button" className="remove-key-button" onClick={() => setShortcutsOpen(true)}>Keyboard shortcuts (Ctrl+/)</button>
              <button type="button" className="back-to-chat" onClick={() => void openPanel("chat")}>
                Back to chat <span aria-hidden="true">→</span>
              </button>
            </div>
          ) : (
            <>
              <div className="conversation" ref={conversationRef} aria-live="polite">
                {messages.length === 0 ? (
                  <div className="welcome-card">
                    <div className="welcome-orb"><span /></div>
                    <div className="eyebrow">YOUR {personalities[personality].label.toUpperCase()}</div>
                    <h1>What should we do?</h1>
                    <p>Tell Cue what you want done, and it will take the next step.</p>
                    <div className="suggestion-list">
                      {suggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          className="suggestion-chip"
                          onClick={() => void sendMessage(suggestion)}
                        >
                          {suggestion}<span aria-hidden="true">↗</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="message-list">
                    {messages.map((message, index) => (
                      <article key={`${index}-${message.role}`} className={`message ${message.role}`}>
                        {message.role === "assistant" && <span className="message-avatar">V</span>}
                        <div className="message-content">
                        {message.role === "assistant" && <span className="message-author">CUE</span>}
                          {message.role === "assistant"
                            ? <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => (
                              <a href={href} target="_blank" rel="noreferrer" onClick={(event) => {
                                event.preventDefault();
                                if (!href || !/^https?:\/\//i.test(href)) return;
                                if (isTauri()) void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(href));
                                else window.open(href, "_blank", "noopener,noreferrer");
                              }}>{children}</a>
                            ) }}>{message.content}</ReactMarkdown></div>
                            : <p>{message.content}</p>}
                        {message.role === "assistant" && <button type="button" className="speak-message" onClick={() => {
                          const playing = ttsAudioRef.current && !ttsAudioRef.current.paused && !ttsAudioRef.current.ended;
                          if (playing) ttsAudioRef.current?.pause();
                          else if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel();
                          else speakText(message.content);
                        }}>Speak / stop</button>}
                        </div>
                      </article>
                    ))}
                    {isSending && (
                      <div className="message assistant">
                        <span className="message-avatar">V</span>
                        <div className="thinking-copy">
                          <span /><span /><span /> {toolStatus || "finding the words…"}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <form
                className="chat-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendMessage(draft);
                }}
              >
                <div className="capture-controls">
                  <button type="button" className={screenSharing ? "capture-button selected" : "capture-button"} disabled={meetingCapture} onClick={() => screenSharing ? stopScreenContext() : void captureScreen()}>
                    {screenSharing ? "Stop screen context" : "Share screen context"}
                  </button>
                  <button type="button" className={meetingCapture ? "capture-button recording" : "capture-button"} onClick={() => meetingCapture ? stopMeetingCapture() : void startMeetingCapture()}>
                    {meetingCapture ? "Stop meeting capture" : "Transcribe meeting"}
                  </button>
                </div>
                {meetingCapture && <p className="capture-notice" role="status">Meeting audio is being transcribed live in short 4-second chunks. Nothing is sent until it is processed by the selected provider.</p>}
                {meetingTranscript && (
                  <div className="meeting-transcript">
                    <div><strong>Meeting notes</strong><span><button type="button" onClick={() => setDraft((value) => `${value}${value ? "\n\n" : ""}${meetingTranscript}`)}>Add to message</button><button type="button" onClick={() => { meetingTranscriptRef.current = ""; setMeetingTranscript(""); }}>Delete</button></span></div>
                    <p>{meetingTranscript}</p>
                  </div>
                )}
                {chatError && (
                  <div className="chat-error" role="alert">
                    <span>{chatError}</span>
                    {provider === "openai" && !apiKeyPresent && (
                      <button type="button" onClick={() => void openPanel("settings")}>Set up key</button>
                    )}
                  </div>
                )}
                <div className="composer-field">
                  <textarea
                    ref={composerRef}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void sendMessage(draft);
                      }
                    }}
                    placeholder={screenSharing ? "Ask about anything on your screen…" : "Tell me what’s on your mind…"}
                    aria-label="Message Cue"
                    rows={1}
                    maxLength={8000}
                    disabled={isSending}
                  />
                  <button type="submit" className="send-button" disabled={!draft.trim() || isSending} aria-label="Send message">
                    {isSending ? (
                      <span className="send-spinner" />
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 19V5m-7 7 7-7 7 7" />
                      </svg>
                    )}
                  </button>
                </div>
                <div className="composer-footer">
                  <span title="Keyboard shortcuts">Ctrl+/ shortcuts · {strictLocal ? "Strict Local · no network" : fullPrivacy ? "Private Mode · on-device AI" : provider === "local" ? "On-device · Ollama" : "Cloud · OpenAI"}{screenSharing ? " · Screen attached when you send" : ""}</span>
                  {messages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setMessages([]);
                        setChatError("");
                      }}
                    >
                      New conversation
                    </button>
                  )}
                </div>
              </form>
            </>
          )}
        </section>
      )}
      {shortcutsOpen && (
        <div className="shortcuts-overlay" role="dialog" aria-label="Keyboard shortcuts" onClick={() => setShortcutsOpen(false)}>
          <div className="shortcuts-card" onClick={(event) => event.stopPropagation()}>
            <div className="shortcuts-head">
              <strong>Keyboard shortcuts</strong>
              <button type="button" onClick={() => setShortcutsOpen(false)} aria-label="Close shortcuts">Esc</button>
            </div>
            {SHORTCUT_GROUPS.map(({ group, items }) => (
              <div key={group} className="shortcuts-group">
                <h3>{group}</h3>
                {items.map(([keys, label]) => {
                  const displayedKeys = keys === "GLOBAL" ? formatHotkey(hotkey) : keys;
                  return (
                    <div key={keys} className="shortcut-row">
                      <span>{label}</span>
                      <span className="kbd-set">
                        {displayedKeys.split(" or ").map((combo, i) => (
                          <span key={combo}>{i > 0 && " or "}{combo.split("+").map((k, j) => <kbd key={j}>{k}</kbd>)}</span>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
      <video ref={screenVideoRef} className="capture-preview" autoPlay muted playsInline aria-hidden="true" />
    </main>
  );
}

export default App;
