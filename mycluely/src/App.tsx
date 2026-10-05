import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

const HOTKEY = "CommandOrControl+Shift+Space";

const personalities: Record<
  AssistantPersonality,
  { label: string; description: string; ready: string; listening: string }
> = {
  wingmate: {
    label: "Wingmate",
    description: "A little wit, always on your side.",
    ready: "Ready when you are.",
    listening: "I'm all ears.",
  },
  coach: {
    label: "Coach",
    description: "Calm, thoughtful, and in your corner.",
    ready: "Take your time.",
    listening: "I'm right here.",
  },
  direct: {
    label: "Direct",
    description: "Clear, concise, straight to it.",
    ready: "Standing by.",
    listening: "Listening.",
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

  const [personality, setPersonality] =
    useState<AssistantPersonality>(() => {
      const savedPersonality =
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

  /*
   * --------------------------------------------------------------------------
   * MICROPHONE
   * --------------------------------------------------------------------------
   */

  const startMicrophone = async () => {
    if (isListeningRef.current) {
      return;
    }

    try {
      console.log("Requesting microphone access...");

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

      const track = stream.getAudioTracks()[0];

      console.log("Microphone stream acquired.");
      console.log("Microphone track:", {
        label: track?.label,
        enabled: track?.enabled,
        muted: track?.muted,
        readyState: track?.readyState,
        settings: track?.getSettings(),
      });

      const audioContext =
        new AudioContext();

      audioContextRef.current =
        audioContext;

      console.log(
        "AudioContext before resume:",
        audioContext.state,
      );

      if (
        audioContext.state === "suspended"
      ) {
        await audioContext.resume();
      }

      console.log(
        "AudioContext after resume:",
        audioContext.state,
      );

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

      isListeningRef.current = true;

      setMicrophoneStatus(
        "Listening",
      );

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

      setMicrophoneStatus(
        "Microphone unavailable",
      );

      setMicrophoneLevel(0);
    }
  };

  const stopMicrophone = async () => {
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

    microphoneLevelRef.current =
      0;

    setMicrophoneLevel(0);

    setMicrophoneStatus("Ready");
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

        console.log(
          `MyCluely hotkey registered: ${HOTKEY}`,
        );
      } catch (error) {
        console.error(
          "Failed to register MyCluely hotkey:",
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
            "Failed to unregister MyCluely hotkey:",
            error,
          );
        },
      );

      void stopMicrophone();
    };
  }, []);

  /*
   * --------------------------------------------------------------------------
   * WINDOW CONTROLS
   * --------------------------------------------------------------------------
   */

  const startWindowDrag = async () => {
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
    window.localStorage.setItem(
      "mycluely.personality",
      nextPersonality,
    );
  };

  /*
   * --------------------------------------------------------------------------
   * VISUAL STATE
   * --------------------------------------------------------------------------
   */

  const level = microphoneLevel;

  const stateLabel =
    copilotState === "idle"
      ? microphoneStatus === "Ready"
        ? personalities[personality].ready
        : microphoneStatus
      : copilotState === "listening"
        ? microphoneStatus === "Listening"
          ? personalities[personality].listening
          : microphoneStatus
        : copilotState === "thinking"
          ? "Thinking"
          : "Responding";

  return (
    <main
      className="app-shell"
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
            <div className="brand-orb">
              <div className="orb-core" />
              <div className="orb-ring orb-ring-one" />
              <div className="orb-ring orb-ring-two" />
            </div>

            <span className="brand-name">
              MyCluely
            </span>
          </div>

          {settingsOpen ? (
            <div
              className="personality-picker"
              onMouseDown={(event) => event.stopPropagation()}
              role="group"
              aria-label="Assistant personality"
            >
              <div className="personality-heading">
                <span className="settings-label">YOUR WINGMATE</span>
                <span className="personality-description">
                  {personalities[personality].description}
                </span>
              </div>
              <div className="personality-options">
                {(Object.keys(personalities) as AssistantPersonality[]).map(
                  (option) => (
                    <button
                      key={option}
                      type="button"
                      className={`personality-option${
                        personality === option ? " selected" : ""
                      }`}
                      onClick={() => selectPersonality(option)}
                      aria-pressed={personality === option}
                      title={personalities[option].description}
                    >
                      {personalities[option].label}
                    </button>
                  ),
                )}
              </div>
            </div>
          ) : (
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
                      microphoneStatus === "Microphone unavailable"
                        ? "error-dot"
                        : "idle-dot"
                    }
                  />
                )}
              </div>

              <span>{stateLabel}</span>
            </div>
          )}
        </div>

        <div
          className="copilot-actions"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            className={`icon-button microphone-button${
              copilotState === "listening" ? " active" : ""
            }`}
            onClick={() => void toggleListening()}
            aria-label={
              copilotState === "listening"
                ? "Stop listening"
                : "Start listening"
            }
            aria-pressed={copilotState === "listening"}
            title={
              copilotState === "listening"
                ? "Stop listening"
                : "Start listening (Ctrl+Shift+Space)"
            }
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
            onClick={() => setSettingsOpen((isOpen) => !isOpen)}
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
    </main>
  );
}

export default App;
