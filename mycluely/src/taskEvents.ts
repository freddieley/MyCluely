// Pure state model for Cue's structured task events (mirrors agent_loop.rs).

export type ActionStatus = "success" | "error" | "cancelled" | "timed_out" | "declined";
export type TaskState =
  | "completed"
  | "partial"
  | "cancelled"
  | "timed_out"
  | "limit_reached"
  | "provider_failed";
export type Verification = "not_applicable" | "unverified" | "observed";

export type TaskEvent = { task_id: number; seq: number } & (
  | { type: "accepted" }
  | { type: "planning"; round: number }
  | { type: "action_proposed"; call_id: string; tool: string; description: string }
  | { type: "confirmation_required"; call_id: string; tool: string; prompt: string }
  | { type: "action_started"; call_id: string; tool: string }
  | { type: "action_finished"; call_id: string; tool: string; status: ActionStatus; detail: string }
  | { type: "screen_capture_requested" }
  | {
      type: "finished";
      state: TaskState;
      verification: Verification;
      summary: string;
      actions_attempted: number;
      actions_succeeded: number;
      actions_failed: number;
    }
);

export type ItemStatus = "proposed" | "awaiting_confirmation" | "running" | ActionStatus;

export interface ActivityItem {
  callId: string;
  tool: string;
  description: string;
  status: ItemStatus;
  detail: string;
}

export interface TaskView {
  taskId: number;
  lastSeq: number;
  phase: "running" | "finished";
  planning: boolean;
  items: ActivityItem[];
  confirmation: { callId: string; prompt: string } | null;
  outcome: { state: TaskState; verification: Verification; summary: string } | null;
}

const OPEN: ItemStatus[] = ["proposed", "awaiting_confirmation", "running"];

function patchItem(items: ActivityItem[], callId: string, patch: Partial<ActivityItem>): ActivityItem[] {
  let index = items.findIndex((item) => item.callId === callId);
  if (index < 0 && callId === "") {
    // Confirmations raised by the model's own tool carry no call id.
    for (let i = items.length - 1; i >= 0; i--) {
      if (OPEN.includes(items[i].status)) {
        index = i;
        break;
      }
    }
  }
  if (index < 0) return items;
  return items.map((item, i) => (i === index ? { ...item, ...patch } : item));
}

/**
 * Applies one event. Events for another task, out-of-order or duplicate
 * events, and anything after the terminal event are ignored, so a stale task
 * can never overwrite a newer one's status.
 */
export function reduceTaskEvent(view: TaskView | null, event: TaskEvent): TaskView | null {
  if (event.type === "accepted") {
    if (view && view.phase === "running" && event.task_id <= view.taskId) return view;
    if (view && event.task_id < view.taskId) return view;
    return {
      taskId: event.task_id,
      lastSeq: event.seq,
      phase: "running",
      planning: false,
      items: [],
      confirmation: null,
      outcome: null,
    };
  }
  if (!view || view.taskId !== event.task_id || view.phase === "finished" || event.seq <= view.lastSeq) {
    return view;
  }
  const next: TaskView = { ...view, lastSeq: event.seq };
  switch (event.type) {
    case "planning":
      return { ...next, planning: true };
    case "action_proposed":
      return {
        ...next,
        planning: false,
        items: [
          ...view.items,
          { callId: event.call_id, tool: event.tool, description: event.description, status: "proposed", detail: "" },
        ],
      };
    case "confirmation_required": {
      const items = patchItem(view.items, event.call_id, { status: "awaiting_confirmation" });
      const target = [...items].reverse().find((item) => item.status === "awaiting_confirmation");
      return {
        ...next,
        items,
        confirmation: { callId: target ? target.callId : event.call_id, prompt: event.prompt },
      };
    }
    case "action_started":
      return { ...next, confirmation: null, items: patchItem(view.items, event.call_id, { status: "running" }) };
    case "action_finished":
      return {
        ...next,
        confirmation: null,
        items: patchItem(view.items, event.call_id, { status: event.status, detail: event.detail }),
      };
    case "finished":
      return {
        ...next,
        phase: "finished",
        planning: false,
        confirmation: null,
        // Anything still open when the task ends did not complete.
        items: view.items.map((item) =>
          OPEN.includes(item.status) ? { ...item, status: "cancelled" as ItemStatus } : item,
        ),
        outcome: { state: event.state, verification: event.verification, summary: event.summary },
      };
    default:
      return next;
  }
}

export function statusLine(view: TaskView | null): string {
  if (!view || view.phase === "finished") return "";
  if (view.confirmation) return "Waiting for your approval";
  const running = [...view.items].reverse().find((item) => OPEN.includes(item.status));
  if (running) return running.description;
  return view.planning ? "Thinking…" : "Starting…";
}

export function outcomeLabel(state: TaskState): string {
  switch (state) {
    case "completed": return "Finished";
    case "partial": return "Partly done";
    case "cancelled": return "Stopped by you";
    case "timed_out": return "Out of time";
    case "limit_reached": return "Stopped by a safety limit";
    case "provider_failed": return "AI provider problem";
  }
}
