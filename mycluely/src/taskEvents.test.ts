// Run with: npm test (Node's built-in test runner; no extra dependencies).
import test from "node:test";
import assert from "node:assert/strict";
import { reduceTaskEvent, statusLine, type TaskEvent, type TaskView } from "./taskEvents.ts";

const base = (task_id: number, seq: number) => ({ task_id, seq });
const apply = (events: TaskEvent[], start: TaskView | null = null) =>
  events.reduce<TaskView | null>((view, event) => reduceTaskEvent(view, event), start);

test("a task moves through proposed, confirmation, running and success", () => {
  let view = apply([
    { ...base(1, 0), type: "accepted" },
    { ...base(1, 1), type: "planning", round: 1 },
    { ...base(1, 2), type: "action_proposed", call_id: "c1", tool: "delete_file", description: "Delete a.txt" },
    { ...base(1, 3), type: "confirmation_required", call_id: "c1", tool: "delete_file", prompt: "Delete a.txt?" },
  ]);
  assert.equal(view?.items[0].status, "awaiting_confirmation");
  assert.equal(view?.confirmation?.prompt, "Delete a.txt?");
  assert.equal(statusLine(view), "Waiting for your approval");
  view = apply(
    [
      { ...base(1, 4), type: "action_started", call_id: "c1", tool: "delete_file" },
      { ...base(1, 5), type: "action_finished", call_id: "c1", tool: "delete_file", status: "success", detail: "Deleted" },
    ],
    view,
  );
  assert.equal(view?.items[0].status, "success");
  assert.equal(view?.confirmation, null);
  assert.equal(view?.phase, "running", "a finished action is not a finished task");
});

test("terminal event marks the task finished, with an honest outcome, and open actions are not shown as done", () => {
  const view = apply([
    { ...base(2, 0), type: "accepted" },
    { ...base(2, 1), type: "action_proposed", call_id: "a", tool: "scroll", description: "Scroll" },
    { ...base(2, 2), type: "action_started", call_id: "a", tool: "scroll" },
    {
      ...base(2, 3),
      type: "finished",
      state: "cancelled",
      verification: "not_applicable",
      summary: "Task stopped by you.",
      actions_attempted: 1,
      actions_succeeded: 0,
      actions_failed: 0,
    },
  ]);
  assert.equal(view?.phase, "finished");
  assert.equal(view?.outcome?.state, "cancelled");
  assert.equal(view?.items[0].status, "cancelled");
  assert.equal(statusLine(view), "");
});

test("events after the terminal event are ignored", () => {
  const finished = apply([
    { ...base(3, 0), type: "accepted" },
    { ...base(3, 1), type: "finished", state: "completed", verification: "not_applicable", summary: "ok", actions_attempted: 0, actions_succeeded: 0, actions_failed: 0 },
  ]);
  const after = reduceTaskEvent(finished, { ...base(3, 2), type: "planning", round: 9 });
  assert.equal(after, finished);
});

test("stale events from an older task cannot overwrite a newer task", () => {
  const newer = apply([{ ...base(5, 0), type: "accepted" }]);
  const stale = reduceTaskEvent(newer, {
    ...base(4, 7),
    type: "finished",
    state: "completed",
    verification: "not_applicable",
    summary: "old",
    actions_attempted: 0,
    actions_succeeded: 0,
    actions_failed: 0,
  });
  assert.equal(stale, newer);
  assert.equal(stale?.phase, "running");
  // an old Accepted can't replace the newer task either
  assert.equal(reduceTaskEvent(newer, { ...base(4, 0), type: "accepted" }), newer);
});

test("duplicate or out-of-order sequence numbers are ignored", () => {
  const view = apply([
    { ...base(6, 0), type: "accepted" },
    { ...base(6, 2), type: "action_proposed", call_id: "x", tool: "scroll", description: "Scroll" },
  ]);
  const again = reduceTaskEvent(view, { ...base(6, 1), type: "action_proposed", call_id: "y", tool: "scroll", description: "late" });
  assert.equal(again?.items.length, 1);
});

test("failed, declined and timed-out actions stay distinguishable", () => {
  const view = apply([
    { ...base(7, 0), type: "accepted" },
    { ...base(7, 1), type: "action_proposed", call_id: "1", tool: "a", description: "A" },
    { ...base(7, 2), type: "action_finished", call_id: "1", tool: "a", status: "error", detail: "boom" },
    { ...base(7, 3), type: "action_proposed", call_id: "2", tool: "b", description: "B" },
    { ...base(7, 4), type: "action_finished", call_id: "2", tool: "b", status: "declined", detail: "no" },
    { ...base(7, 5), type: "action_proposed", call_id: "3", tool: "c", description: "C" },
    { ...base(7, 6), type: "action_finished", call_id: "3", tool: "c", status: "timed_out", detail: "slow" },
  ]);
  assert.deepEqual(view?.items.map((item) => item.status), ["error", "declined", "timed_out"]);
});

test("a confirmation from the model's own tool (no call id) attaches to the open action", () => {
  const view = apply([
    { ...base(8, 0), type: "accepted" },
    { ...base(8, 1), type: "action_proposed", call_id: "k", tool: "request_confirmation", description: "Ask you" },
    { ...base(8, 2), type: "action_started", call_id: "k", tool: "request_confirmation" },
    { ...base(8, 3), type: "confirmation_required", call_id: "", tool: "request_confirmation", prompt: "Send it?" },
  ]);
  assert.equal(view?.items[0].status, "awaiting_confirmation");
  assert.equal(view?.confirmation?.callId, "k");
});
