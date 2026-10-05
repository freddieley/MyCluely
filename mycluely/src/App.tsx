import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import "./App.css";

type CopilotState =
  | "idle"
  | "listening"
  | "thinking"
  | "responding";

const HOTKEY = "CommandOrControl+Shift+Space";

const stateLabels: Record<CopilotState, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  responding: "Responding",
};

function App() {
  const [copilotState, setCopilotState] =
    useState<CopilotState>("idle");

  const [settingsOpen, setSettingsOpen] = useState(false);

  async function closeWindow() {
    try {
      await invoke("close_window");
    } catch (error) {
      console.error("Failed to close window:", error);
    }
  }

  async function startDragging() {
    try {
      await invoke("start_window_drag");
    } catch (error) {
      console.error("Failed to drag window:", error);
    }
  }

  function toggleSettings() {
    setSettingsOpen((current) => !current);
  }

  useEffect(() => {
    let mounted = true;

    async function setupHotkey() {
      try {
        await register(HOTKEY, (event) => {
          if (!mounted) {
            return;
          }

          if (event.state === "Pressed") {
            setSettingsOpen(false);

            setCopilotState((current) =>
              current === "listening"
                ? "idle"
                : "listening",
            );
          }
        });

        console.log(
          `MyCluely hotkey registered: ${HOTKEY}`,
        );
      } catch (error) {
        console.error(
          "Failed to register MyCluely hotkey:",
          error,
        );
      }
    }

    setupHotkey();

    return () => {
      mounted = false;

      unregister(HOTKEY).catch((error) => {
        console.error(
          "Failed to unregister MyCluely hotkey:",
          error,
        );
      });
    };
  }, []);

  const currentLabel = settingsOpen
    ? "Settings"
    : stateLabels[copilotState];

  return (
    <main className="app-shell">
      <section
        className={`copilot-bar state-${copilotState} ${
          settingsOpen ? "settings-open" : ""
        }`}
      >
        <div
          className="copilot-drag-region"
          onMouseDown={(event) => {
            if (event.button === 0) {
              startDragging();
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

          <div className="copilot-status">
            <div className="state-indicator">
              {copilotState === "listening" && (
                <>
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </>
              )}

              {copilotState === "thinking" && (
                <div className="thinking-spinner" />
              )}

              {copilotState === "responding" && (
                <div className="responding-pulse" />
              )}

              {copilotState === "idle" && (
                <div className="idle-dot" />
              )}

              {settingsOpen && (
                <div className="settings-indicator" />
              )}
            </div>

            <span>{currentLabel}</span>
          </div>
        </div>

        <div
          className="copilot-actions"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          <button
            className={`icon-button ${
              settingsOpen ? "active" : ""
            }`}
            type="button"
            aria-label="Settings"
            onClick={toggleSettings}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />

              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1.5 1.6v.1h-2.5v-.1a1.7 1.7 0 0 0-1.5-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1.5H5.3v-2.5h.1a1.7 1.7 0 0 0 1.6-1.5 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1.5-1.6V5.3h2.5v.1a1.7 1.7 0 0 0 1.5 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1.5h.1v2.5h-.1a1.7 1.7 0 0 0-1.6 1.5Z" />
            </svg>
          </button>

          <button
            className="icon-button close-button"
            type="button"
            aria-label="Close"
            onClick={closeWindow}
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