import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {
  const [status, setStatus] = useState("Ready");

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

  function openSettings() {
    setStatus((current) =>
      current === "Settings" ? "Ready" : "Settings",
    );
  }

  return (
    <main className="app-shell">
      <section className="copilot-bar">
        <div
          className="copilot-drag-region"
          onMouseDown={(event) => {
            if (event.button === 0) {
              startDragging();
            }
          }}
        >
          <div className="copilot-brand">
            <div className="brand-mark">
              <span />
              <span />
              <span />
            </div>

            <span className="brand-name">MyCluely</span>
          </div>

          <div className="copilot-status">
            <span
              className={`status-dot ${
                status === "Settings"
                  ? "status-dot-settings"
                  : ""
              }`}
            />

            <span>{status}</span>
          </div>
        </div>

        <div
          className="copilot-actions"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
        >
          <button
            className="icon-button"
            type="button"
            aria-label="Settings"
            onClick={openSettings}
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
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.8 1.8-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V22h-2.54v-.1a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.8-1.8.06-.06A1.7 1.7 0 0 0 8.12 17a1.7 1.7 0 0 0-1.56-1.03H6.5v-2.54h.06A1.7 1.7 0 0 0 8.12 12.4a1.7 1.7 0 0 0-.34-1.88l-.06-.06 1.8-1.8.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.56V5h2.54v.06a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.8 1.8-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H21v2.54h-.06A1.7 1.7 0 0 0 19.4 15Z" />
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