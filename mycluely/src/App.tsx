import { useEffect, useRef, useState } from "react";
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
  | "responding";

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

const HOTKEY = "CommandOrControl+Shift+Space";
const CHAT_SUGGESTIONS = [
  "Help me prep for an interview",
  "Make this sound more confident",
  "Give me a clever way to start",
];

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
  const [localAiStatus, setLocalAiStatus] = useState<LocalAiStatus | null>(null);
  const [localModel, setLocalModel] = useState(
    () => window.localStorage.getItem("vela.model") ?? "",
  );
  const [localStatusMessage, setLocalStatusMessage] = useState("");
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
    const mono = (await offlineContext.startRendering()).getChannelData(0);
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
    if (!isTauri()) return;
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
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    invoke("set_always_on_top", { enabled: alwaysOnTop }).catch((error: unknown) => {
      console.error("Couldn't apply always-on-top preference:", error);
      setLocalStatusMessage("Couldn't update the always-on-top preference.");
    });
    window.localStorage.setItem("vela.alwaysOnTop", String(alwaysOnTop));
  }, [alwaysOnTop]);

  useEffect(() => {
    if (conversationRef.current) {
      conversationRef.current.scrollTop =
        conversationRef.current.scrollHeight;
    }
  }, [messages, isSending]);

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
          }, 30_000);
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
      }, 30_000);

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
        await openPanel("chat");
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
        await register(
          HOTKEY,
          async () => {
            if (!mounted) {
              return;
            }

            await toggleListening();
          },
        );

        console.log(`Vela hotkey registered: ${HOTKEY}`);
      } catch (error) {
        console.error(
          "Failed to register Vela hotkey:",
          error,
        );
      }
    };

    setupHotkey();

    return () => {
      mounted = false;

      unregister(HOTKEY).catch(
        (error) => {
          console.error(
            "Failed to unregister Vela hotkey:",
            error,
          );
        },
      );

      void stopMicrophone(false);
    };
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
      console.error("Failed to expand Vela:", error);
      setChatError("Couldn't open the assistant panel. Try again.");
    }
  };

  const collapsePanel = async () => {
    try {
      if (isTauri()) {
        await invoke("set_window_expanded", { expanded: false });
      }

      setExpanded(false);
      setSettingsOpen(false);
      setChatError("");
    } catch (error) {
      console.error("Failed to collapse Vela:", error);
      setChatError("Couldn't close the assistant panel. Try again.");
    }
  };

  const saveApiKey = async () => {
    const apiKey = apiKeyInput.trim();
    if (!apiKey) {
      setCredentialStatus("Paste your OpenAI API key first.");
      return;
    }

    if (!isTauri()) {
      setCredentialStatus("Save your API key from the Vela desktop app.");
      return;
    }

    setCredentialStatus("");
    try {
      await invoke("save_api_key", { apiKey });
      setApiKeyPresent(true);
      setApiKeyInput("");
      setCredentialStatus("Saved securely in your system keychain.");
    } catch (error) {
      console.error("Failed to save API key:", error);
      setCredentialStatus(
        typeof error === "string" ? error : "Couldn't save the API key.",
      );
    }
  };

  const removeApiKey = async () => {
    if (!isTauri()) {
      setCredentialStatus("Manage your API key from the Vela desktop app.");
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

  const chooseProvider = (nextProvider: Provider) => {
    setProvider(nextProvider);
    window.localStorage.setItem("vela.provider", nextProvider);
    if (nextProvider === "openai" && fullPrivacy) {
      setFullPrivacy(false);
      window.localStorage.setItem("vela.fullPrivacy", "false");
    }
  };

  const choosePrivacyMode = (enabled: boolean) => {
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
    }, 30_000);
  };

  startMeetingSegmentRef.current = startMeetingSegment;

  const startMeetingCapture = async () => {
    if (!isTauri() || meetingCapture) return;
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
    if (!screenSharing || !screenVideoRef.current) return undefined;
    const video = screenVideoRef.current;
    await new Promise<void>((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) resolve();
      else video.addEventListener("loadeddata", () => resolve(), { once: true });
    });
    const scale = Math.min(1, 1280 / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL("image/jpeg", 0.65).split(",", 2)[1];
    return jpeg;
  };

  const speakText = async (text: string) => {
    if (!speakReplies) return;
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
      setChatError("Vela's built-in voice couldn't play this reply.");
      return;
    }
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  };

  const sendMessage = async (messageText: string) => {
    const content = messageText.trim();
    if (!content || isSending) {
      return;
    }

    if (!isTauri()) {
      setChatError("Chat is available in the Vela desktop app.");
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

    try {
      const screenImage = await snapshotScreen();
      const stream = new Channel<string>();
      let streamed = "";
      setMessages([...nextMessages, { role: "assistant", content: "" }]);
      stream.onmessage = (delta) => {
        streamed += delta;
        const snapshot = streamed;
        setMessages([...nextMessages, { role: "assistant", content: snapshot }]);
      };
      const reply = await invoke<string>("send_chat_message", {
        messages: nextMessages.slice(-12),
        personality,
        provider,
        model: localModel,
        fullPrivacy,
        screenImage: screenImage ?? null,
        onDelta: stream,
      });
      setMessages([
        ...nextMessages,
        { role: "assistant", content: reply },
      ]);
      speakText(reply);
    } catch (error) {
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
          : "Responding";

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
              Vela
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

                {copilotState === "idle" && (
                  <div
                    className={
                      meetingCapture
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
            aria-label={alwaysOnTop ? "Unlock Vela from the top of the screen" : "Keep Vela on top of the screen"}
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
                : "Record a voice message (Ctrl+Shift+Space)"
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

      {expanded && (
        <section className="assistant-panel" aria-label="Vela assistant">
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
                    <h2>Choose where Vela thinks</h2>
                  </div>
                </div>
                <div className="provider-choice" role="group" aria-label="AI provider">
                  <button type="button" className={provider === "openai" ? "selected" : ""} onClick={() => chooseProvider("openai")} aria-pressed={provider === "openai"}>
                    <strong>Cloud</strong><span>OpenAI API</span>
                  </button>
                  <button type="button" className={provider === "local" ? "selected" : ""} onClick={() => chooseProvider("local")} aria-pressed={provider === "local"}>
                    <strong>On-device</strong><span>Ollama</span>
                  </button>
                </div>
                <label className="privacy-toggle">
                  <input type="checkbox" checked={fullPrivacy} onChange={(event) => choosePrivacyMode(event.target.checked)} />
                  <span><strong>Full Privacy Mode</strong><small>Block all cloud chat and transcription. Uses local Ollama plus Vela's built-in speech models.</small></span>
                </label>
                {provider === "local" && (
                  <div className="local-model-setup">
                    <div className="local-model-row">
                      <label htmlFor="local-model">Local model</label>
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
                        : "Install and start Ollama, then pull a model such as qwen3:4b. Vela will never silently fall back to the cloud."}
                    </p>
                  </div>
                )}
                {localStatusMessage && <p className="credential-status" role="status">{localStatusMessage}</p>}
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
                <p className="provider-copy">Your key stays in your system keychain. Cloud chat and transcription are sent to OpenAI only when Cloud is selected; screen images are attached only when you enable screen context.</p>
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
                  <label className="privacy-toggle">
                    <input type="checkbox" checked={alwaysOnTop} onChange={(event) => setAlwaysOnTop(event.target.checked)} />
                    <span><strong>Keep the Vela bar on top</strong><small>Pin the floating assistant above other windows.</small></span>
                  </label>
                  <label className="privacy-toggle">
                    <input type="checkbox" checked={speakReplies} onChange={(event) => {
                      setSpeakReplies(event.target.checked);
                      window.localStorage.setItem("vela.speakReplies", String(event.target.checked));
                      if (!event.target.checked) window.speechSynthesis?.cancel();
                    }} />
                    <span><strong>Speak replies aloud</strong><small>Uses system voices. Full Privacy Mode only uses voices marked local by your system. Use Stop speaking to silence a reply.</small></span>
                  </label>
                  <button type="button" className="remove-key-button" onClick={() => window.speechSynthesis?.cancel()}>Stop speaking</button>
                </div>
                {credentialStatus && (
                  <p className="credential-status" role="status">{credentialStatus}</p>
                )}
              </div>
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
                    <h1>Hey, I’m in your corner.</h1>
                    <p>Bring me the awkward bit, the big question, or the blank page. We’ll figure it out together.</p>
                    <div className="suggestion-list">
                      {CHAT_SUGGESTIONS.map((suggestion) => (
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
                        {message.role === "assistant" && <span className="message-author">VELA</span>}
                          <p>{message.content}</p>
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
                          <span /><span /><span /> finding the words…
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
                {meetingCapture && <p className="capture-notice" role="status">Meeting audio is being transcribed in 30-second segments. Nothing is sent until it is processed by the selected provider.</p>}
                {meetingTranscript && (
                  <div className="meeting-transcript">
                    <div><strong>Meeting notes</strong><button type="button" onClick={() => setDraft((value) => `${value}${value ? "\n\n" : ""}${meetingTranscript}`)}>Add to message</button></div>
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
                    aria-label="Message Vela"
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
                  <span>{fullPrivacy ? "Full Privacy Mode · local model only" : provider === "local" ? "On-device · Ollama" : "Cloud · OpenAI"}{screenSharing ? " · Screen attached when you send" : ""}</span>
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
      <video ref={screenVideoRef} className="capture-preview" autoPlay muted playsInline aria-hidden="true" />
    </main>
  );
}

export default App;
