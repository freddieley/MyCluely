//! Bounded, observable agent execution loop.
//!
//! The loop is provider-agnostic: a [`AgentProvider`] turns a typed transcript
//! into a [`ProviderTurn`] (text plus *structured* tool calls) and an
//! [`ActionBackend`] performs approved actions. Every tool call, whatever its
//! origin, is run through [`agent_policy::guarded_execute`]; this module never
//! executes anything itself, and ordinary assistant prose is never parsed as
//! an instruction.
//!
//! Limits ([`AgentLimits`]) bound the number of tool attempts, the wall-clock
//! time (excluding time spent waiting for the user to answer a confirmation),
//! consecutive failures and identical repeated calls.
//!
//! Cancellation limitation: cancelling stops the loop from scheduling further
//! work and abandons the *wait* for a running tool. Blocking operating-system
//! calls (mouse/keyboard input) that already started cannot be interrupted and
//! may still complete; the report says so rather than claiming otherwise.

use crate::agent_policy::{self, LoopGuard, Status, TaskContext, ToolClass, ToolReport};
use serde::Serialize;
use serde_json::{json, Value};
use std::future::Future;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::Instant;

const MAX_RESULT_CHARS: usize = 9_000;
const MAX_EVENT_DETAIL: usize = 300;

// ---------------------------------------------------------------- limits ---

#[derive(Clone, Debug)]
pub struct AgentLimits {
    /// Maximum tool-call attempts per task (executed, rejected or malformed).
    pub max_tool_calls: u32,
    /// Wall-clock budget, excluding time waiting for user confirmations.
    pub deadline: Duration,
    pub max_consecutive_failures: u32,
    pub max_identical_calls: u32,
    /// Tool calls honoured from a single provider turn; the rest are refused.
    pub max_calls_per_turn: usize,
}

impl Default for AgentLimits {
    fn default() -> Self {
        Self {
            max_tool_calls: 12,
            deadline: Duration::from_secs(180),
            max_consecutive_failures: 3,
            max_identical_calls: 3,
            max_calls_per_turn: 4,
        }
    }
}

impl AgentLimits {
    /// Clamps every limit to a sane, non-zero range.
    pub fn validated(mut self) -> Self {
        self.max_tool_calls = self.max_tool_calls.clamp(1, 50);
        self.deadline = self
            .deadline
            .clamp(Duration::from_secs(5), Duration::from_secs(900));
        self.max_consecutive_failures = self.max_consecutive_failures.clamp(1, 10);
        self.max_identical_calls = self.max_identical_calls.clamp(2, 10);
        self.max_calls_per_turn = self.max_calls_per_turn.clamp(1, 8);
        self
    }
}

// ----------------------------------------------------------------- types ---

#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AgentMessage {
    User {
        content: String,
        image: Option<String>,
    },
    Assistant {
        text: String,
        tool_calls: Vec<ToolCall>,
    },
    ToolResult {
        call_id: String,
        name: String,
        content: String,
        image: Option<String>,
    },
}

/// A tool call exactly as the provider proposed it. `args` is `Err` when the
/// provider's arguments were not a valid JSON object; such calls are never run.
#[derive(Clone, Debug, PartialEq)]
pub struct ProposedCall {
    pub id: Option<String>,
    pub name: String,
    pub args: Result<Value, String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProviderTurn {
    pub text: String,
    pub calls: Vec<ProposedCall>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProviderError {
    Cancelled,
    /// The provider/model can't do what was asked (e.g. no tool calling).
    Unsupported(String),
    Failed(String),
}

pub trait AgentProvider: Send {
    fn next_turn(
        &mut self,
        transcript: &[AgentMessage],
        cancel: watch::Receiver<bool>,
    ) -> impl Future<Output = Result<ProviderTurn, ProviderError>> + Send;
}

pub trait ActionBackend: Sync {
    fn confirm(
        &self,
        prompt: String,
        cancel: watch::Receiver<bool>,
    ) -> impl Future<Output = Result<bool, String>> + Send;
    fn execute(
        &self,
        name: &str,
        args: &Value,
        cancel: watch::Receiver<bool>,
    ) -> impl Future<Output = Result<String, String>> + Send;
    /// Image produced by the last successful `name` (e.g. a fresh snapshot).
    fn observation_image(&self, _name: &str) -> Option<String> {
        None
    }
}

// ---------------------------------------------------------------- events ---

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    /// The model finished and no action failed at the end.
    Completed,
    /// The model finished but the last action failed or was declined.
    Partial,
    Cancelled,
    TimedOut,
    /// Stopped by a safety limit (budget, failures, repetition).
    LimitReached,
    ProviderFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verification {
    /// No state-changing action succeeded, so there was nothing to verify.
    NotApplicable,
    /// State-changing actions ran and nothing re-checked the result.
    Unverified,
    /// The model re-inspected state (screen/folder/file) after the last
    /// successful change. This is evidence, not an automated proof.
    Observed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskEventKind {
    Accepted,
    Planning {
        round: u32,
    },
    ActionProposed {
        call_id: String,
        tool: String,
        description: String,
    },
    ConfirmationRequired {
        call_id: String,
        tool: String,
        prompt: String,
    },
    ActionStarted {
        call_id: String,
        tool: String,
    },
    ActionFinished {
        call_id: String,
        tool: String,
        status: Status,
        detail: String,
    },
    ScreenCaptureRequested,
    Finished {
        state: TaskState,
        verification: Verification,
        summary: String,
        actions_attempted: u32,
        actions_succeeded: u32,
        actions_failed: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TaskEvent {
    pub task_id: u64,
    pub seq: u32,
    #[serde(flatten)]
    pub kind: TaskEventKind,
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: TaskEvent);
}

/// Stamps events with the task id and a per-task sequence number.
#[derive(Clone)]
pub struct Emitter {
    task_id: u64,
    seq: Arc<AtomicU32>,
    sink: Arc<dyn EventSink>,
}

impl Emitter {
    pub fn new(task_id: u64, sink: Arc<dyn EventSink>) -> Self {
        Self {
            task_id,
            seq: Arc::new(AtomicU32::new(0)),
            sink,
        }
    }

    pub fn task_id(&self) -> u64 {
        self.task_id
    }

    pub fn emit(&self, kind: TaskEventKind) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        self.sink.emit(TaskEvent {
            task_id: self.task_id,
            seq,
            kind,
        });
    }
}

/// Test sink that records events.
#[cfg(test)]
#[derive(Default)]
pub struct CollectingSink(pub Mutex<Vec<TaskEvent>>);

#[cfg(test)]
impl EventSink for CollectingSink {
    fn emit(&self, event: TaskEvent) {
        if let Ok(mut events) = self.0.lock() {
            events.push(event);
        }
    }
}

// ---------------------------------------------------------------- result ---

#[derive(Clone, Debug, PartialEq)]
pub struct ActionRecord {
    pub call_id: String,
    pub tool: String,
    pub status: Status,
    pub detail: String,
}

#[derive(Clone, Debug)]
pub struct TaskResult {
    pub state: TaskState,
    pub verification: Verification,
    /// The model's final answer, when it gave one.
    pub final_text: String,
    pub stop_reason: Option<String>,
    pub actions: Vec<ActionRecord>,
    pub attempted: u32,
}

impl TaskResult {
    pub fn succeeded(&self) -> u32 {
        self.actions
            .iter()
            .filter(|a| a.status == Status::Success)
            .count() as u32
    }

    pub fn failed(&self) -> u32 {
        self.actions
            .iter()
            .filter(|a| matches!(a.status, Status::Error | Status::TimedOut))
            .count() as u32
    }

    fn lines(&self, status: impl Fn(Status) -> bool) -> Vec<String> {
        self.actions
            .iter()
            .filter(|a| status(a.status))
            .map(|a| format!("{} ({})", a.tool, truncate(&a.detail, 80)))
            .collect()
    }

    /// Honest, human-readable account of what happened.
    pub fn summary(&self) -> String {
        let headline = match self.state {
            TaskState::Completed => "Task finished.".to_string(),
            TaskState::Partial => "Task partly done: the last action did not succeed.".to_string(),
            TaskState::Cancelled => "Task stopped by you.".to_string(),
            TaskState::TimedOut => "Task stopped: it ran out of time.".to_string(),
            TaskState::LimitReached => format!(
                "Task stopped by a safety limit: {}",
                self.stop_reason.as_deref().unwrap_or("limit reached")
            ),
            TaskState::ProviderFailed => format!(
                "Task stopped: {}",
                self.stop_reason
                    .as_deref()
                    .unwrap_or("the AI provider failed")
            ),
        };
        let mut parts = vec![headline];
        let done = self.lines(|s| s == Status::Success);
        let failed = self.lines(|s| matches!(s, Status::Error | Status::TimedOut));
        let declined = self.lines(|s| s == Status::Declined);
        if !done.is_empty() {
            parts.push(format!("Done: {}.", done.join("; ")));
        }
        if !failed.is_empty() {
            parts.push(format!("Failed: {}.", failed.join("; ")));
        }
        if !declined.is_empty() {
            parts.push(format!(
                "Declined by you (not performed): {}.",
                declined.join("; ")
            ));
        }
        if !matches!(self.state, TaskState::Completed | TaskState::Partial) {
            parts.push(
                "The request may be incomplete; remaining steps were not attempted.".to_string(),
            );
        }
        match self.verification {
            Verification::Unverified => parts.push(
                "Cue did not re-check the result, so success of these changes is unverified.".to_string(),
            ),
            Verification::Observed => parts.push(
                "Cue re-checked the result afterwards (assistant's judgement, not automatic proof).".to_string(),
            ),
            Verification::NotApplicable => {}
        }
        parts.join(" ")
    }

    /// Text shown to the user as the final message.
    pub fn final_message(&self) -> String {
        let clean = self.state == TaskState::Completed
            && matches!(
                self.verification,
                Verification::NotApplicable | Verification::Observed
            );
        if clean && !self.final_text.trim().is_empty() {
            return self.final_text.clone();
        }
        if self.final_text.trim().is_empty() {
            self.summary()
        } else {
            format!("{}\n\n_{}_", self.final_text.trim_end(), self.summary())
        }
    }
}

// --------------------------------------------------------------- helpers ---

fn truncate(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

/// Short description for the activity list. Never includes typed text or file
/// contents, which may be sensitive.
pub fn describe_action(name: &str, args: &Value) -> String {
    let text = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .map(|v| truncate(v.trim(), 120))
            .unwrap_or_default()
    };
    match name {
        "open_application" => format!("Open {}", text("app")),
        "open_url" => format!("Open {}", text("url")),
        "type_text" => {
            let n = args
                .get("text")
                .and_then(Value::as_str)
                .map_or(0, |t| t.chars().count());
            format!("Type {n} characters into the focused app")
        }
        "press_key" => format!("Press {}", text("key")),
        "key_combo" => {
            let keys: Vec<&str> = args["keys"]
                .as_array()
                .map(|k| k.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            format!("Press {}", keys.join("+"))
        }
        "mouse_click" => format!("Click at ({}, {})", args["x"], args["y"]),
        "scroll" => format!("Scroll by {}", args["amount"]),
        "refresh_screen" => "Look at the screen".to_string(),
        "screen_size" => "Check the screen size".to_string(),
        "create_file" => format!("Create {}", text("path")),
        "read_file" => format!("Read {}", text("path")),
        "list_directory" => format!("List {}", text("path")),
        "move_file" => format!("Move {} to {}", text("from"), text("to")),
        "delete_file" => format!("Delete {}", text("path")),
        "request_confirmation" => format!("Ask you: {}", text("action")),
        "web_search" => format!("Search the web for \"{}\"", text("query")),
        "fetch_url" => format!("Read {}", text("url")),
        "browse_page" => format!("Browse {}", text("url")),
        "get_datetime" => "Check the date and time".to_string(),
        other => format!("Unknown tool {}", truncate(other, 40)),
    }
}

fn is_observation(tool: &str) -> bool {
    matches!(tool, "refresh_screen" | "list_directory" | "read_file")
}

pub fn assess_verification(actions: &[ActionRecord]) -> Verification {
    let last_change = actions.iter().rposition(|a| {
        a.status == Status::Success && agent_policy::tool_class(&a.tool) == Some(ToolClass::Action)
    });
    match last_change {
        None => Verification::NotApplicable,
        Some(index) => {
            if actions[index + 1..]
                .iter()
                .any(|a| a.status == Status::Success && is_observation(&a.tool))
            {
                Verification::Observed
            } else {
                Verification::Unverified
            }
        }
    }
}

fn clean_call_id(id: Option<&str>, fallback: String, used: &[String]) -> String {
    match id {
        Some(id)
            if !id.is_empty()
                && id.len() <= 64
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                && !used.iter().any(|u| u == id) =>
        {
            id.to_string()
        }
        _ => fallback,
    }
}

// ------------------------------------------------------- task registry ---

/// Tracks the single active task. A new task is refused (never silently
/// replacing or cancelling another), and cancel/end only touch the task whose
/// id they name.
#[derive(Default)]
pub struct TaskRegistry {
    next_id: AtomicU64,
    active: Mutex<Option<(u64, watch::Sender<bool>)>>,
}

impl TaskRegistry {
    pub fn begin(&self) -> Result<(u64, watch::Receiver<bool>), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Task state is unavailable.".to_string())?;
        if active.is_some() {
            return Err("Cue is already working on a task. Stop it first.".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (sender, receiver) = watch::channel(false);
        *active = Some((id, sender));
        Ok((id, receiver))
    }

    /// Cancels `task_id` (or the active task when `None`). Returns the id that
    /// was cancelled, if any.
    pub fn cancel(&self, task_id: Option<u64>) -> Option<u64> {
        let active = self.active.lock().ok()?;
        match active.as_ref() {
            Some((id, sender)) if task_id.is_none_or(|wanted| wanted == *id) => {
                sender.send_replace(true);
                Some(*id)
            }
            _ => None,
        }
    }

    pub fn end(&self, task_id: u64) {
        if let Ok(mut active) = self.active.lock() {
            if active.as_ref().is_some_and(|(id, _)| *id == task_id) {
                *active = None;
            }
        }
    }

    #[cfg(test)]
    pub fn active_id(&self) -> Option<u64> {
        self.active.lock().ok()?.as_ref().map(|(id, _)| *id)
    }
}

/// A single pending reply (confirmation or screen snapshot) owned by a task.
/// Replies from, or cleanup for, a different task never touch it.
pub struct PendingSlot<T> {
    inner: Mutex<Option<(u64, tokio::sync::oneshot::Sender<T>)>>,
}

impl<T> Default for PendingSlot<T> {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl<T> PendingSlot<T> {
    pub fn register(&self, task_id: u64) -> Result<tokio::sync::oneshot::Receiver<T>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Pending state is unavailable.".to_string())?;
        if inner.is_some() {
            return Err("Another request is already waiting for a reply.".to_string());
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        *inner = Some((task_id, sender));
        Ok(receiver)
    }

    pub fn resolve(&self, task_id: u64, value: T) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Pending state is unavailable.".to_string())?;
        match inner.take() {
            Some((id, sender)) if id == task_id => sender
                .send(value)
                .map_err(|_| "The request is no longer waiting.".to_string()),
            other => {
                *inner = other;
                Err("Nothing from this task is waiting for a reply.".to_string())
            }
        }
    }

    pub fn clear(&self, task_id: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.as_ref().is_some_and(|(id, _)| *id == task_id) {
                *inner = None;
            }
        }
    }
}

// ------------------------------------------------------------------ loop ---

struct Budget {
    start: Instant,
    limit: Duration,
    /// Milliseconds spent waiting for the user, which don't count.
    paused_ms: AtomicU64,
}

impl Budget {
    fn deadline(&self) -> Instant {
        self.start + self.limit + Duration::from_millis(self.paused_ms.load(Ordering::SeqCst))
    }

    fn remaining(&self) -> Duration {
        self.deadline().saturating_duration_since(Instant::now())
    }
}

struct Run {
    actions: Vec<ActionRecord>,
    attempted: u32,
}

fn finish(
    emitter: &Emitter,
    run: Run,
    state: TaskState,
    final_text: String,
    stop_reason: Option<String>,
) -> TaskResult {
    let mut state = state;
    if state == TaskState::Completed {
        if let Some(last) = run.actions.last() {
            if matches!(
                last.status,
                Status::Error | Status::TimedOut | Status::Declined
            ) {
                state = TaskState::Partial;
            }
        }
    }
    let verification = assess_verification(&run.actions);
    let result = TaskResult {
        state,
        verification,
        final_text,
        stop_reason,
        actions: run.actions,
        attempted: run.attempted,
    };
    emitter.emit(TaskEventKind::Finished {
        state,
        verification,
        summary: result.summary(),
        actions_attempted: result.attempted,
        actions_succeeded: result.succeeded(),
        actions_failed: result.failed(),
    });
    result
}

/// Runs one task to a terminal state. Emits `Accepted` first and exactly one
/// `Finished` last. No tool is started once cancellation, the deadline or the
/// action budget has been observed.
pub async fn run_task<P: AgentProvider, B: ActionBackend>(
    provider: &mut P,
    backend: &B,
    emitter: &Emitter,
    mut transcript: Vec<AgentMessage>,
    limits: &AgentLimits,
    cancel: &watch::Receiver<bool>,
) -> TaskResult {
    let limits = limits.clone().validated();
    emitter.emit(TaskEventKind::Accepted);
    let budget = Budget {
        start: Instant::now(),
        limit: limits.deadline,
        paused_ms: AtomicU64::new(0),
    };
    let mut run = Run {
        actions: Vec::new(),
        attempted: 0,
    };
    let mut guard = LoopGuard::new(limits.max_identical_calls, limits.max_consecutive_failures);
    let mut tainted = false;
    let mut used_ids: Vec<String> = Vec::new();
    let mut round = 0u32;

    macro_rules! stop {
        ($state:expr, $text:expr, $reason:expr) => {
            return finish(emitter, run, $state, $text, $reason)
        };
    }

    loop {
        if agent_policy::is_cancelled(cancel) {
            stop!(TaskState::Cancelled, String::new(), None);
        }
        if budget.remaining().is_zero() {
            stop!(
                TaskState::TimedOut,
                String::new(),
                Some("the time limit was reached".into())
            );
        }
        round += 1;
        emitter.emit(TaskEventKind::Planning { round });
        let turn = tokio::select! {
            biased;
            _ = agent_policy::wait_cancelled(cancel.clone()) => Err(ProviderError::Cancelled),
            _ = tokio::time::sleep_until(budget.deadline()) => {
                stop!(TaskState::TimedOut, String::new(), Some("the time limit was reached".into()))
            }
            result = provider.next_turn(&transcript, cancel.clone()) => result,
        };
        let turn = match turn {
            Ok(turn) => turn,
            Err(ProviderError::Cancelled) => stop!(TaskState::Cancelled, String::new(), None),
            Err(ProviderError::Unsupported(reason)) | Err(ProviderError::Failed(reason)) => {
                stop!(TaskState::ProviderFailed, String::new(), Some(reason))
            }
        };
        if agent_policy::is_cancelled(cancel) {
            stop!(TaskState::Cancelled, String::new(), None);
        }
        if turn.calls.is_empty() {
            if turn.text.trim().is_empty() {
                stop!(
                    TaskState::ProviderFailed,
                    String::new(),
                    Some("the assistant returned an empty response".into())
                );
            }
            stop!(TaskState::Completed, turn.text, None);
        }

        // Assign stable ids and echo every proposed call into the transcript.
        let mut calls: Vec<(ToolCall, Result<(), String>)> = Vec::new();
        for (index, proposed) in turn.calls.iter().enumerate() {
            let id = clean_call_id(
                proposed.id.as_deref(),
                format!("call_{}_{round}_{index}", emitter.task_id()),
                &used_ids,
            );
            used_ids.push(id.clone());
            let (args, parse) = match &proposed.args {
                Ok(args) => (args.clone(), Ok(())),
                Err(error) => (json!({}), Err(error.clone())),
            };
            calls.push((
                ToolCall {
                    id,
                    name: proposed.name.clone(),
                    args,
                },
                parse,
            ));
        }
        transcript.push(AgentMessage::Assistant {
            text: turn.text.clone(),
            tool_calls: calls.iter().map(|(call, _)| call.clone()).collect(),
        });

        for (index, (call, parse)) in calls.iter().enumerate() {
            if agent_policy::is_cancelled(cancel) {
                stop!(TaskState::Cancelled, String::new(), None);
            }
            if budget.remaining().is_zero() {
                stop!(
                    TaskState::TimedOut,
                    String::new(),
                    Some("the time limit was reached".into())
                );
            }
            if run.attempted >= limits.max_tool_calls {
                stop!(
                    TaskState::LimitReached,
                    String::new(),
                    Some(format!(
                        "the limit of {} actions per task was reached",
                        limits.max_tool_calls
                    ))
                );
            }
            let push_result =
                |transcript: &mut Vec<AgentMessage>, content: String, image: Option<String>| {
                    transcript.push(AgentMessage::ToolResult {
                        call_id: call.id.clone(),
                        name: call.name.clone(),
                        content,
                        image,
                    });
                };
            if index >= limits.max_calls_per_turn {
                push_result(
                    &mut transcript,
                    "Tool error: not executed. Request at most a few actions at a time."
                        .to_string(),
                    None,
                );
                continue;
            }
            run.attempted += 1;
            let description = describe_action(&call.name, &call.args);
            emitter.emit(TaskEventKind::ActionProposed {
                call_id: call.id.clone(),
                tool: call.name.clone(),
                description,
            });

            let report = if let Err(error) = parse {
                ToolReport {
                    tool: call.name.clone(),
                    status: Status::Error,
                    message: format!("Malformed tool arguments: {error}"),
                    confirmation_required: false,
                }
            } else {
                let timeout = agent_policy::tool_timeout(&call.name).min(budget.remaining());
                agent_policy::guarded_execute(
                    &call.name,
                    &call.args,
                    TaskContext { tainted },
                    cancel,
                    timeout,
                    |prompt| {
                        emitter.emit(TaskEventKind::ConfirmationRequired {
                            call_id: call.id.clone(),
                            tool: call.name.clone(),
                            prompt: truncate(&prompt, MAX_EVENT_DETAIL),
                        });
                        let waited = Instant::now();
                        let cancel = cancel.clone();
                        let budget = &budget;
                        async move {
                            let answer = backend.confirm(prompt, cancel).await;
                            budget
                                .paused_ms
                                .fetch_add(waited.elapsed().as_millis() as u64, Ordering::SeqCst);
                            answer
                        }
                    },
                    || {
                        emitter.emit(TaskEventKind::ActionStarted {
                            call_id: call.id.clone(),
                            tool: call.name.clone(),
                        });
                        backend.execute(&call.name, &call.args, cancel.clone())
                    },
                )
                .await
            };

            let untrusted =
                agent_policy::tool_class(&call.name) == Some(ToolClass::UntrustedSource);
            let detail = if report.is_success() && untrusted {
                format!(
                    "Returned {} characters of untrusted content.",
                    report.message.chars().count()
                )
            } else {
                truncate(&report.message, MAX_EVENT_DETAIL)
            };
            emitter.emit(TaskEventKind::ActionFinished {
                call_id: call.id.clone(),
                tool: call.name.clone(),
                status: report.status,
                detail: detail.clone(),
            });
            run.actions.push(ActionRecord {
                call_id: call.id.clone(),
                tool: call.name.clone(),
                status: report.status,
                detail,
            });
            if report.status == Status::Cancelled || agent_policy::is_cancelled(cancel) {
                stop!(TaskState::Cancelled, String::new(), None);
            }
            if report.is_success() && untrusted {
                tainted = true;
            }
            let mut content: String = report.for_model().chars().take(MAX_RESULT_CHARS).collect();
            if report.is_success() && untrusted {
                content = agent_policy::wrap_untrusted(&call.name, &content);
            }
            let image = if report.is_success() {
                backend.observation_image(&call.name)
            } else {
                None
            };
            push_result(&mut transcript, content, image);
            // A declined action is the user's choice, not a failure.
            let recorded = guard.record(
                &call.name,
                &call.args,
                report.is_success() || report.status == Status::Declined,
            );
            if let Err(stop) = recorded {
                stop!(
                    TaskState::LimitReached,
                    String::new(),
                    Some(stop.message().to_string())
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool;

    struct FakeProvider {
        turns: VecDeque<Result<ProviderTurn, ProviderError>>,
        /// Records the transcript length seen on each call.
        seen: Vec<usize>,
        delay: Option<Duration>,
    }

    impl FakeProvider {
        fn new(turns: Vec<Result<ProviderTurn, ProviderError>>) -> Self {
            Self {
                turns: turns.into(),
                seen: Vec::new(),
                delay: None,
            }
        }
    }

    impl AgentProvider for FakeProvider {
        async fn next_turn(
            &mut self,
            transcript: &[AgentMessage],
            _cancel: watch::Receiver<bool>,
        ) -> Result<ProviderTurn, ProviderError> {
            self.seen.push(transcript.len());
            if let Some(delay) = self.delay {
                tokio::time::sleep(delay).await;
            }
            self.turns
                .pop_front()
                .unwrap_or_else(|| Err(ProviderError::Failed("provider script exhausted".into())))
        }
    }

    #[derive(Default)]
    struct FakeBackend {
        executed: Mutex<Vec<String>>,
        confirm_answer: Mutex<Option<Result<bool, String>>>,
        confirmations: AtomicU32,
        fail_first: AtomicU32,
        fail_tools: AtomicBool,
        hang_tools: AtomicBool,
        on_execute: Mutex<Option<watch::Sender<bool>>>,
        on_confirm: Mutex<Option<watch::Sender<bool>>>,
    }

    impl ActionBackend for FakeBackend {
        async fn confirm(
            &self,
            _prompt: String,
            _cancel: watch::Receiver<bool>,
        ) -> Result<bool, String> {
            self.confirmations.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = self.on_confirm.lock().unwrap().as_ref() {
                tx.send_replace(true);
            }
            self.confirm_answer
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(Ok(true))
        }
        async fn execute(
            &self,
            name: &str,
            _args: &Value,
            _cancel: watch::Receiver<bool>,
        ) -> Result<String, String> {
            self.executed.lock().unwrap().push(name.to_string());
            if let Some(tx) = self.on_execute.lock().unwrap().as_ref() {
                tx.send_replace(true);
            }
            if self.hang_tools.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
            if self.fail_tools.load(Ordering::SeqCst)
                || self
                    .fail_first
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
                    .is_ok()
            {
                Err("simulated failure".into())
            } else {
                Ok(format!("{name} ok"))
            }
        }
    }

    fn call(name: &str, args: Value) -> ProposedCall {
        ProposedCall {
            id: None,
            name: name.into(),
            args: Ok(args),
        }
    }
    fn turn(text: &str, calls: Vec<ProposedCall>) -> Result<ProviderTurn, ProviderError> {
        Ok(ProviderTurn {
            text: text.into(),
            calls,
        })
    }
    fn user() -> Vec<AgentMessage> {
        vec![AgentMessage::User {
            content: "do it".into(),
            image: None,
        }]
    }

    async fn run_with(
        provider: &mut FakeProvider,
        backend: &FakeBackend,
        limits: AgentLimits,
        cancel: &watch::Receiver<bool>,
    ) -> (TaskResult, Vec<TaskEvent>) {
        let sink = Arc::new(CollectingSink::default());
        let emitter = Emitter::new(7, sink.clone());
        let result = run_task(provider, backend, &emitter, user(), &limits, cancel).await;
        let events = sink.0.lock().unwrap().clone();
        (result, events)
    }

    fn kinds(events: &[TaskEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|e| match e.kind {
                TaskEventKind::Accepted => "accepted",
                TaskEventKind::Planning { .. } => "planning",
                TaskEventKind::ActionProposed { .. } => "proposed",
                TaskEventKind::ConfirmationRequired { .. } => "confirm",
                TaskEventKind::ActionStarted { .. } => "started",
                TaskEventKind::ActionFinished { .. } => "finished",
                TaskEventKind::ScreenCaptureRequested => "capture",
                TaskEventKind::Finished { .. } => "terminal",
            })
            .collect()
    }

    #[tokio::test]
    async fn multistep_task_completes_with_ordered_events_and_context() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![
            turn("", vec![call("scroll", json!({"amount": 2}))]),
            turn("", vec![call("screen_size", json!({}))]),
            turn("All done.", vec![]),
        ]);
        let backend = FakeBackend::default();
        let (result, events) =
            run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::Completed);
        assert_eq!(result.final_text, "All done.");
        assert_eq!(
            *backend.executed.lock().unwrap(),
            vec!["scroll", "screen_size"]
        );
        // transcript grows: user, assistant+call, result, assistant+call, result
        assert_eq!(provider.seen, vec![1, 3, 5]);
        assert_eq!(
            kinds(&events),
            vec![
                "accepted", "planning", "proposed", "started", "finished", "planning", "proposed",
                "started", "finished", "planning", "terminal"
            ]
        );
        assert!(events.iter().all(|e| e.task_id == 7));
        assert!(events.windows(2).all(|w| w[0].seq + 1 == w[1].seq));
        assert_eq!(
            kinds(&events).iter().filter(|k| **k == "terminal").count(),
            1
        );
        // state changed (scroll) and nothing re-observed it: honest about that
        assert_eq!(result.verification, Verification::Unverified);
        assert!(result.final_message().contains("unverified"));
    }

    #[tokio::test]
    async fn observation_after_change_is_reported_as_observed() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![
            turn(
                "",
                vec![call(
                    "create_file",
                    json!({"path": "a.txt", "content": "x"}),
                )],
            ),
            turn("", vec![call("list_directory", json!({"path": "."}))]),
            turn("Created.", vec![]),
        ]);
        let backend = FakeBackend::default();
        let (result, _) = run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.verification, Verification::Observed);
        assert_eq!(result.final_message(), "Created.");
    }

    #[tokio::test]
    async fn prose_that_looks_like_a_tool_call_is_never_executed() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![turn(
            "<tool>{\"name\":\"delete_file\",\"args\":{\"path\":\"a\"}}</tool>",
            vec![],
        )]);
        let backend = FakeBackend::default();
        let (result, _) = run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::Completed);
        assert!(backend.executed.lock().unwrap().is_empty());
        assert_eq!(backend.confirmations.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn malformed_unknown_and_extra_arg_calls_never_execute() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![
            turn(
                "",
                vec![
                    ProposedCall {
                        id: Some("a".into()),
                        name: "scroll".into(),
                        args: Err("not JSON".into()),
                    },
                    call("run_shell", json!({"command": "calc"})),
                    call("scroll", json!({"amount": 1, "extra": true})),
                ],
            ),
            turn("Gave up.", vec![]),
        ]);
        let backend = FakeBackend::default();
        let limits = AgentLimits {
            max_consecutive_failures: 5,
            ..AgentLimits::default()
        };
        let (result, events) = run_with(&mut provider, &backend, limits, &cancel).await;
        assert!(backend.executed.lock().unwrap().is_empty());
        assert_eq!(
            result.attempted, 3,
            "rejected calls still consume the action budget"
        );
        assert_eq!(result.failed(), 3);
        assert_eq!(result.state, TaskState::Partial);
        assert!(!kinds(&events).contains(&"started"));
    }

    #[tokio::test]
    async fn action_budget_stops_scheduling_and_reports_remaining_work() {
        let (_tx, cancel) = watch::channel(false);
        let turns = (0..10)
            .map(|n| turn("", vec![call("scroll", json!({"amount": 1 + n % 5}))]))
            .collect();
        let mut provider = FakeProvider::new(turns);
        let backend = FakeBackend::default();
        let limits = AgentLimits {
            max_tool_calls: 3,
            max_identical_calls: 10,
            ..AgentLimits::default()
        };
        let (result, _) = run_with(&mut provider, &backend, limits, &cancel).await;
        assert_eq!(result.state, TaskState::LimitReached);
        assert_eq!(backend.executed.lock().unwrap().len(), 3);
        assert_eq!(result.attempted, 3);
        let message = result.final_message();
        assert!(
            message.contains("Done:") && message.contains("incomplete"),
            "{message}"
        );
    }

    #[tokio::test]
    async fn parallel_calls_in_one_turn_count_against_budget() {
        let (_tx, cancel) = watch::channel(false);
        let calls = (1..=6)
            .map(|n| call("scroll", json!({"amount": n})))
            .collect();
        let mut provider = FakeProvider::new(vec![turn("", calls), turn("done", vec![])]);
        let backend = FakeBackend::default();
        let limits = AgentLimits {
            max_tool_calls: 3,
            max_calls_per_turn: 8,
            ..AgentLimits::default()
        };
        let (result, _) = run_with(&mut provider, &backend, limits, &cancel).await;
        assert_eq!(backend.executed.lock().unwrap().len(), 3);
        assert_eq!(result.state, TaskState::LimitReached);
    }

    #[tokio::test]
    async fn calls_beyond_per_turn_cap_are_refused_not_run() {
        let (_tx, cancel) = watch::channel(false);
        let calls = (1..=4)
            .map(|n| call("scroll", json!({"amount": n})))
            .collect();
        let mut provider = FakeProvider::new(vec![turn("", calls), turn("ok", vec![])]);
        let backend = FakeBackend::default();
        let limits = AgentLimits {
            max_calls_per_turn: 2,
            ..AgentLimits::default()
        };
        let (result, _) = run_with(&mut provider, &backend, limits, &cancel).await;
        assert_eq!(backend.executed.lock().unwrap().len(), 2);
        assert_eq!(result.attempted, 2);
        assert_eq!(
            provider.seen,
            vec![1, 6],
            "every proposed call still gets a result message"
        );
    }

    #[tokio::test]
    async fn repeated_failures_stop_the_task() {
        let (_tx, cancel) = watch::channel(false);
        let turns = (1..=8)
            .map(|n| turn("", vec![call("scroll", json!({"amount": n}))]))
            .collect();
        let mut provider = FakeProvider::new(turns);
        let backend = FakeBackend::default();
        backend.fail_tools.store(true, Ordering::SeqCst);
        let (result, _) = run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::LimitReached);
        assert_eq!(backend.executed.lock().unwrap().len(), 3);
        assert!(result.stop_reason.unwrap().contains("in a row failed"));
    }

    #[tokio::test]
    async fn repeated_identical_calls_stop_the_task() {
        let (_tx, cancel) = watch::channel(false);
        let turns = (0..8)
            .map(|_| turn("", vec![call("scroll", json!({"amount": 1}))]))
            .collect();
        let mut provider = FakeProvider::new(turns);
        let backend = FakeBackend::default();
        let (result, _) = run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::LimitReached);
        assert!(result.stop_reason.unwrap().contains("repeated"));
        assert_eq!(backend.executed.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn recoverable_failure_can_be_followed_by_a_successful_retry() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![
            turn("", vec![call("read_file", json!({"path": "missing"}))]),
            turn("", vec![call("list_directory", json!({"path": "."}))]),
            turn("Found it.", vec![]),
        ]);
        let backend = FakeBackend::default();
        backend.fail_first.store(1, Ordering::SeqCst);
        let (result, _) = run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::Completed);
        assert_eq!(result.failed(), 1);
        assert_eq!(result.succeeded(), 1);
    }

    #[tokio::test]
    async fn failed_last_action_means_partial_not_success() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![
            turn("", vec![call("read_file", json!({"path": "missing"}))]),
            turn("I could not read it.", vec![]),
        ]);
        let backend = FakeBackend::default();
        backend.fail_tools.store(true, Ordering::SeqCst);
        let (result, _) = run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::Partial);
        assert!(result.final_message().contains("Failed:"));
    }

    #[test]
    fn registry_refuses_second_task_and_scopes_cancel_and_end() {
        let registry = TaskRegistry::default();
        let (first, rx_first) = registry.begin().unwrap();
        assert!(
            registry.begin().is_err(),
            "a new task must not replace the running one"
        );
        assert!(registry.cancel(Some(first + 99)).is_none());
        assert!(
            !*rx_first.borrow(),
            "a stale id must not cancel the active task"
        );
        registry.end(first + 99);
        assert_eq!(registry.active_id(), Some(first));
        assert_eq!(registry.cancel(Some(first)), Some(first));
        assert!(*rx_first.borrow());
        registry.end(first);
        let (second, rx_second) = registry.begin().unwrap();
        assert_ne!(first, second);
        assert!(!*rx_second.borrow(), "new task starts uncancelled");
        assert!(registry.cancel(None).is_some());
        assert!(*rx_second.borrow());
    }

    #[test]
    fn pending_replies_only_reach_their_own_task() {
        let slot: PendingSlot<bool> = PendingSlot::default();
        let mut receiver = slot.register(1).unwrap();
        assert!(slot.register(2).is_err());
        assert!(slot.resolve(2, true).is_err(), "another task can't answer");
        slot.clear(2);
        assert!(
            receiver.try_recv().is_err(),
            "still pending after foreign clear/resolve"
        );
        assert!(slot.resolve(1, true).is_ok());
        assert_eq!(receiver.try_recv(), Ok(true));
        assert!(slot.resolve(1, true).is_err(), "single use");
    }

    #[tokio::test]
    async fn deadline_stops_a_hung_tool_and_the_task() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![
            turn("", vec![call("scroll", json!({"amount": 1}))]),
            turn("", vec![call("scroll", json!({"amount": 2}))]),
        ]);
        let backend = FakeBackend::default();
        backend.hang_tools.store(true, Ordering::SeqCst);
        tokio::time::pause();
        let limits = AgentLimits {
            deadline: Duration::from_secs(5),
            ..AgentLimits::default()
        };
        let (result, _) = run_with(&mut provider, &backend, limits, &cancel).await;
        assert_ne!(result.state, TaskState::Completed);
        assert_eq!(
            backend.executed.lock().unwrap().len(),
            1,
            "no new action after the deadline"
        );
        assert!(matches!(
            result.state,
            TaskState::TimedOut | TaskState::LimitReached
        ));
    }

    #[tokio::test]
    async fn deadline_during_provider_request_times_out() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![turn("late", vec![])]);
        provider.delay = Some(Duration::from_secs(60));
        let backend = FakeBackend::default();
        tokio::time::pause();
        let limits = AgentLimits {
            deadline: Duration::from_secs(5),
            ..AgentLimits::default()
        };
        let (result, events) = run_with(&mut provider, &backend, limits, &cancel).await;
        assert_eq!(result.state, TaskState::TimedOut);
        assert!(matches!(
            events.last().unwrap().kind,
            TaskEventKind::Finished {
                state: TaskState::TimedOut,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn cancellation_during_planning_runs_nothing() {
        let (tx, cancel) = watch::channel(false);
        let mut provider =
            FakeProvider::new(vec![turn("", vec![call("scroll", json!({"amount": 1}))])]);
        provider.delay = Some(Duration::from_secs(30));
        let backend = FakeBackend::default();
        tokio::time::pause();
        let canceller = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            tx.send_replace(true);
        };
        let ((result, _), _) = tokio::join!(
            run_with(&mut provider, &backend, AgentLimits::default(), &cancel),
            canceller
        );
        assert_eq!(result.state, TaskState::Cancelled);
        assert!(backend.executed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancellation_while_confirming_prevents_the_action() {
        let (tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![
            turn("", vec![call("delete_file", json!({"path": "a.txt"}))]),
            turn("should never be asked", vec![]),
        ]);
        let backend = FakeBackend::default();
        *backend.on_confirm.lock().unwrap() = Some(tx); // cancel lands while the prompt is open
        *backend.confirm_answer.lock().unwrap() = Some(Ok(true));
        let (result, events) =
            run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::Cancelled);
        assert!(backend.executed.lock().unwrap().is_empty());
        assert_eq!(
            provider.seen.len(),
            1,
            "no further planning after cancellation"
        );
        assert!(matches!(
            events.last().unwrap().kind,
            TaskEventKind::Finished {
                state: TaskState::Cancelled,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn cancellation_during_execution_stops_following_actions() {
        let (tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![
            turn(
                "",
                vec![
                    call("scroll", json!({"amount": 1})),
                    call("scroll", json!({"amount": 2})),
                ],
            ),
            turn("never", vec![]),
        ]);
        let backend = FakeBackend::default();
        *backend.on_execute.lock().unwrap() = Some(tx);
        let (result, _) = run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::Cancelled);
        assert_eq!(
            backend.executed.lock().unwrap().len(),
            1,
            "second call must not start"
        );
        assert_eq!(provider.seen.len(), 1);
    }

    #[tokio::test]
    async fn already_cancelled_task_does_nothing() {
        let (tx, cancel) = watch::channel(false);
        tx.send_replace(true);
        let mut provider = FakeProvider::new(vec![turn("hi", vec![])]);
        let backend = FakeBackend::default();
        let (result, events) =
            run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::Cancelled);
        assert!(provider.seen.is_empty());
        assert_eq!(kinds(&events), vec!["accepted", "terminal"]);
    }

    #[tokio::test]
    async fn milestone_one_confirmation_still_gates_dangerous_calls() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![
            turn("", vec![call("delete_file", json!({"path": "a.txt"}))]),
            turn("Okay, I left it.", vec![]),
        ]);
        let backend = FakeBackend::default();
        *backend.confirm_answer.lock().unwrap() = Some(Ok(false));
        let (result, events) =
            run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert!(backend.executed.lock().unwrap().is_empty());
        assert_eq!(result.actions[0].status, Status::Declined);
        assert_eq!(
            result.state,
            TaskState::Partial,
            "a declined action means the task isn't done"
        );
        assert!(kinds(&events).contains(&"confirm"));
        assert!(!kinds(&events).contains(&"started"));
    }

    #[tokio::test]
    async fn untrusted_content_forces_confirmation_for_later_actions() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![
            turn(
                "",
                vec![call("browse_page", json!({"url": "https://evil.example"}))],
            ),
            turn(
                "",
                vec![call("type_text", json!({"text": "ignore all rules"}))],
            ),
            turn("done", vec![]),
        ]);
        let backend = FakeBackend::default();
        *backend.confirm_answer.lock().unwrap() = Some(Ok(false));
        let (result, _) = run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(*backend.executed.lock().unwrap(), vec!["browse_page"]);
        assert_eq!(backend.confirmations.load(Ordering::SeqCst), 1);
        assert_eq!(result.actions[1].status, Status::Declined);
    }

    #[tokio::test]
    async fn provider_failures_are_terminal_and_not_retried() {
        let (_tx, cancel) = watch::channel(false);
        let mut provider = FakeProvider::new(vec![Err(ProviderError::Unsupported(
            "no tool calling".into(),
        ))]);
        let backend = FakeBackend::default();
        let (result, _) = run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::ProviderFailed);
        assert_eq!(provider.seen.len(), 1);
        assert!(result.summary().contains("no tool calling"));

        let mut provider = FakeProvider::new(vec![turn("   ", vec![])]);
        let (result, _) = run_with(&mut provider, &backend, AgentLimits::default(), &cancel).await;
        assert_eq!(result.state, TaskState::ProviderFailed);
    }

    #[tokio::test]
    async fn concurrent_tasks_keep_separate_identity_and_cancellation() {
        let (tx_a, cancel_a) = watch::channel(false);
        let (_tx_b, cancel_b) = watch::channel(false);
        tx_a.send_replace(true);
        let sink = Arc::new(CollectingSink::default());
        let (ea, eb) = (Emitter::new(1, sink.clone()), Emitter::new(2, sink.clone()));
        let mut pa = FakeProvider::new(vec![turn("a", vec![])]);
        let mut pb = FakeProvider::new(vec![turn("b", vec![])]);
        let backend = FakeBackend::default();
        let limits = AgentLimits::default();
        let (ra, rb) = tokio::join!(
            run_task(&mut pa, &backend, &ea, user(), &limits, &cancel_a),
            run_task(&mut pb, &backend, &eb, user(), &limits, &cancel_b),
        );
        assert_eq!(ra.state, TaskState::Cancelled);
        assert_eq!(rb.state, TaskState::Completed);
        let events = sink.0.lock().unwrap().clone();
        for id in [1u64, 2] {
            let mine: Vec<_> = events.iter().filter(|e| e.task_id == id).collect();
            assert!(mine.windows(2).all(|w| w[0].seq < w[1].seq));
            assert!(matches!(
                mine.last().unwrap().kind,
                TaskEventKind::Finished { .. }
            ));
        }
    }

    #[test]
    fn events_serialize_with_task_id_and_type_tag() {
        let event = TaskEvent {
            task_id: 9,
            seq: 2,
            kind: TaskEventKind::ActionFinished {
                call_id: "c".into(),
                tool: "scroll".into(),
                status: Status::TimedOut,
                detail: "x".into(),
            },
        };
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["task_id"], 9);
        assert_eq!(value["type"], "action_finished");
        assert_eq!(value["status"], "timed_out");
    }

    #[test]
    fn action_descriptions_do_not_leak_typed_text() {
        let description = describe_action("type_text", &json!({"text": "hunter2-secret"}));
        assert!(!description.contains("hunter2"));
        assert!(description.contains("14 characters"));
    }

    #[test]
    fn limits_are_clamped() {
        let limits = AgentLimits {
            max_tool_calls: 0,
            deadline: Duration::ZERO,
            max_consecutive_failures: 0,
            max_identical_calls: 0,
            max_calls_per_turn: 0,
        }
        .validated();
        assert!(limits.max_tool_calls >= 1 && limits.deadline >= Duration::from_secs(5));
        assert!(limits.max_identical_calls >= 2 && limits.max_calls_per_turn >= 1);
    }
}
