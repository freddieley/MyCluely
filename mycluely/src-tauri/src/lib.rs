#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use sysinfo::System;
use tauri::ipc::Channel;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

const KEYRING_SERVICE: &str = "com.freddieley.vela";
const LEGACY_KEYRING_SERVICE: &str = "com.freddieley.mycluely";
const KEYRING_USER: &str = "openai-api-key";
const OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static AUDIO_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(45))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("valid HTTP client configuration")
    })
}

#[cfg(test)]
mod tests {
    use super::validate_privacy_provider;

    #[test]
    fn full_privacy_rejects_cloud_provider() {
        assert!(validate_privacy_provider("openai", true).is_err());
    }

    #[test]
    fn full_privacy_allows_local_provider() {
        assert!(validate_privacy_provider("local", true).is_ok());
    }

    #[test]
    fn cloud_provider_is_allowed_when_full_privacy_is_off() {
        assert!(validate_privacy_provider("openai", false).is_ok());
    }
}

#[derive(Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
    #[serde(default)]
    image: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OpenAiResponse {
    choices: Option<Vec<OpenAiChoice>>,
    error: Option<OpenAiError>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OpenAiMessage {
    content: String,
}

#[derive(Deserialize)]
struct OpenAiError {
    message: String,
}

#[derive(Deserialize)]
struct OpenAiTranscription {
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAiStatus {
    available: bool,
    models: Vec<LocalAiModel>,
    total_memory_gb: u64,
    cpu_threads: usize,
    recommended_model: String,
    error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct LocalAiModel {
    name: String,
    vision: bool,
}

#[derive(Deserialize)]
struct OllamaTags {
    models: Vec<OllamaTag>,
}

#[derive(Deserialize)]
struct OllamaTag {
    name: String,
}

fn api_key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| error.to_string())
}

fn get_api_key() -> Result<String, String> {
    let entry = api_key_entry()?;
    match entry.get_password() {
        Ok(api_key) => Ok(api_key),
        Err(keyring::Error::NoEntry) => {
            let legacy = keyring::Entry::new(LEGACY_KEYRING_SERVICE, KEYRING_USER)
                .map_err(|error| error.to_string())?;
            match legacy.get_password() {
                Ok(api_key) => {
                    entry
                        .set_password(&api_key)
                        .map_err(|error| format!("Couldn't migrate your saved API key: {error}"))?;
                    Ok(api_key)
                }
                Err(keyring::Error::NoEntry) => Err(
                    "Add your OpenAI API key in settings before using cloud features.".to_string(),
                ),
                Err(error) => Err(format!("Couldn't read your saved API key: {error}")),
            }
        }
        Err(error) => Err(format!("Couldn't read your saved API key: {error}")),
    }
}

async fn get_ollama_tags() -> Result<OllamaTags, String> {
    let response = http_client()
        .get(format!("{OLLAMA_BASE_URL}/api/tags"))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map_err(|_| {
            "Ollama isn't running. Install Ollama and start it to use local models.".to_string()
        })?;

    if !response.status().is_success() {
        return Err(format!(
            "Ollama returned {} while listing local models.",
            response.status()
        ));
    }

    response
        .json::<OllamaTags>()
        .await
        .map_err(|error| format!("Couldn't read Ollama's model list: {error}"))
}

fn vision_capability(details: &Value) -> bool {
    details
        .get("capabilities")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some("vision")))
}

async fn model_supports_vision(model: &str) -> Result<bool, String> {
    let response = http_client()
        .post(format!("{OLLAMA_BASE_URL}/api/show"))
        .json(&json!({ "model": model }))
        .send()
        .await
        .map_err(|error| format!("Couldn't inspect local model: {error}"))?;
    if !response.status().is_success() {
        return Ok(false);
    }
    let details = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Couldn't read local model details: {error}"))?;
    Ok(vision_capability(&details))
}

fn speech_dir(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let relative = format!("resources/speech/{name}");
    let bundled = app
        .path()
        .resolve(&relative, tauri::path::BaseDirectory::Resource)
        .map_err(|error| error.to_string())?;
    if bundled.is_dir() {
        return Ok(bundled);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    if dev.is_dir() {
        return Ok(dev);
    }
    Err("Vela's bundled speech models are missing. Run scripts/fetch-speech-assets.ps1 and rebuild.".to_string())
}

#[tauri::command]
async fn synthesize_speech(app: AppHandle, text: String) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use std::io::Write;
    use std::process::Stdio;

    let text: String = text.chars().take(4000).collect();
    if text.trim().is_empty() {
        return Err("Nothing to speak.".to_string());
    }
    let dir = speech_dir(&app, "piper")?;
    let sequence = AUDIO_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let output =
        std::env::temp_dir().join(format!("vela-tts-{}-{sequence}.wav", std::process::id()));
    let output_task = output.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(dir.join("piper.exe"));
        command
            .current_dir(&dir)
            .arg("--model")
            .arg(dir.join("voice.onnx"))
            .arg("--output_file")
            .arg(&output_task)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("Couldn't start the voice engine: {error}"))?;
        child
            .stdin
            .take()
            .ok_or("Couldn't talk to the voice engine.")?
            .write_all(text.replace('\n', " ").as_bytes())
            .map_err(|error| error.to_string())?;
        let status = child.wait().map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("The voice engine failed.".to_string());
        }
        fs::read(&output_task).map_err(|error| error.to_string())
    })
    .await;
    let _ = fs::remove_file(&output);
    let bytes = result.map_err(|error| error.to_string())??;
    Ok(STANDARD.encode(bytes))
}
#[tauri::command]
fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn start_window_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_always_on_top(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_always_on_top(enabled)
        .map_err(|error| error.to_string())?;
    if enabled {
        dock_to_top(&window)?;
    }
    Ok(())
}

fn dock_to_top(window: &WebviewWindow) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?);
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let width = window
        .outer_size()
        .map_err(|error| error.to_string())?
        .width as i32;
    let origin = monitor.position();
    let x = origin.x + (monitor.size().width as i32 - width) / 2;
    let y = origin.y + (12.0 * monitor.scale_factor()) as i32;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_window_expanded(window: WebviewWindow, expanded: bool) -> Result<(), String> {
    let size = if expanded {
        LogicalSize::new(680.0, 600.0)
    } else {
        LogicalSize::new(680.0, 84.0)
    };

    window.set_size(size).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_api_key_status() -> Result<bool, String> {
    match get_api_key() {
        Ok(_) => Ok(true),
        Err(message) if message.starts_with("Add your OpenAI API key") => Ok(false),
        Err(message) => Err(message),
    }
}

#[tauri::command]
fn save_api_key(api_key: String) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() || api_key.len() > 512 {
        return Err("Enter a valid API key.".to_string());
    }

    let entry = api_key_entry()?;
    entry
        .set_password(api_key)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_api_key() -> Result<(), String> {
    let entry = api_key_entry()?;

    for service in [KEYRING_SERVICE, LEGACY_KEYRING_SERVICE] {
        let entry =
            keyring::Entry::new(service, KEYRING_USER).map_err(|error| error.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    drop(entry);
    Ok(())
}

#[tauri::command]
async fn get_local_ai_status() -> LocalAiStatus {
    let mut system = System::new();
    system.refresh_memory();
    let total_memory_gb = system.total_memory() / 1_000_000_000;
    let cpu_threads = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    let recommended_model = if total_memory_gb >= 16 {
        "qwen3:8b"
    } else if total_memory_gb >= 8 {
        "qwen3:4b"
    } else {
        "qwen3:1.7b"
    }
    .to_string();

    match get_ollama_tags().await {
        Ok(tags) => {
            let mut models = Vec::with_capacity(tags.models.len());
            for tag in tags.models {
                let vision = model_supports_vision(&tag.name).await.unwrap_or(false);
                models.push(LocalAiModel {
                    name: tag.name,
                    vision,
                });
            }
            LocalAiStatus {
                available: true,
                models,
                total_memory_gb,
                cpu_threads,
                recommended_model,
                error: None,
            }
        }
        Err(error) => LocalAiStatus {
            available: false,
            models: Vec::new(),
            total_memory_gb,
            cpu_threads,
            recommended_model,
            error: Some(error),
        },
    }
}

fn validate_privacy_provider(provider: &str, full_privacy: bool) -> Result<(), String> {
    if full_privacy && provider != "local" {
        return Err("Full Privacy Mode only permits local processing.".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn transcribe_audio(
    app: AppHandle,
    audio_base64: String,
    mime_type: String,
    provider: String,
    full_privacy: bool,
) -> Result<String, String> {
    validate_privacy_provider(&provider, full_privacy)?;

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    let mime_type = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let extension = match mime_type.as_str() {
        "audio/webm" => "webm",
        "audio/mp4" => "mp4",
        "audio/ogg" => "ogg",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" => "mp3",
        _ => return Err("This microphone recording format isn't supported.".to_string()),
    };

    let audio = STANDARD
        .decode(audio_base64)
        .map_err(|_| "Couldn't read the microphone recording.".to_string())?;
    if audio.is_empty() || audio.len() > 25_000_000 {
        return Err("The voice recording is empty or too large to transcribe.".to_string());
    }

    match provider.as_str() {
        "local" => {
            let dir = speech_dir(&app, "whisper")?;
            let executable = dir.join("whisper-cli.exe");
            let model = dir.join("ggml-base.en.bin");

            let sequence = AUDIO_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let prefix = format!("vela-voice-{}-{sequence}", std::process::id());
            let audio_path = std::env::temp_dir().join(format!("{prefix}.{extension}"));
            let output_prefix = std::env::temp_dir().join(format!("{prefix}-transcript"));
            let output_path = output_prefix.with_extension("txt");
            let audio_path_cleanup = audio_path.clone();
            let output_path_cleanup = output_path.clone();
            fs::write(&audio_path, &audio)
                .map_err(|error| format!("Couldn't prepare local audio: {error}"))?;

            let result = tauri::async_runtime::spawn_blocking(move || {
                let process = Command::new(&executable)
                    .current_dir(&dir)
                    .arg("-m")
                    .arg(&model)
                    .arg("-t")
                    .arg(
                        std::thread::available_parallelism()
                            .map_or(4, |n| n.get().min(8))
                            .to_string(),
                    )
                    .arg("-f")
                    .arg(&audio_path)
                    .arg("-nt")
                    .arg("-l")
                    .arg("en")
                    .arg("-otxt")
                    .arg("-of")
                    .arg(&output_prefix)
                    .output()
                    .map_err(|error| format!("Couldn't start whisper.cpp: {error}"))?;
                if !process.status.success() {
                    return Err(format!(
                        "Local transcription failed: {}",
                        String::from_utf8_lossy(&process.stderr).trim()
                    ));
                }
                fs::read_to_string(&output_path)
                    .map(|text| text.trim().to_string())
                    .map_err(|error| format!("Couldn't read local transcript: {error}"))
            })
            .await;

            let _ = fs::remove_file(&audio_path_cleanup);
            let _ = fs::remove_file(&output_path_cleanup);
            result.map_err(|error| format!("Local transcription task failed: {error}"))?
        }
        "openai" => {
            let api_key = get_api_key()?;
            let file = reqwest::multipart::Part::bytes(audio)
                .file_name(format!("voice-note.{extension}"))
                .mime_str(&mime_type)
                .map_err(|error| format!("Couldn't prepare the voice note: {error}"))?;
            let form = reqwest::multipart::Form::new()
                .text("model", "whisper-1")
                .part("file", file);

            let response = http_client()
                .post("https://api.openai.com/v1/audio/transcriptions")
                .bearer_auth(api_key)
                .multipart(form)
                .send()
                .await
                .map_err(|error| format!("Couldn't reach OpenAI: {error}"))?;

            let status = response.status();
            if !status.is_success() {
                let result = response.json::<OpenAiResponse>().await.map_err(|error| {
                    format!("OpenAI returned {status}; couldn't read its error: {error}")
                })?;
                return Err(result
                    .error
                    .map(|error| error.message)
                    .unwrap_or_else(|| format!("OpenAI returned {status}.")));
            }

            response
                .json::<OpenAiTranscription>()
                .await
                .map(|result| result.text.trim().to_string())
                .map_err(|error| format!("Couldn't read the transcription response: {error}"))
        }
        _ => Err("Choose either OpenAI or local transcription.".to_string()),
    }
}

async fn stream_lines<F>(
    mut response: reqwest::Response,
    on_delta: &Channel<String>,
    mut parse: F,
) -> Result<String, String>
where
    F: FnMut(&str) -> Option<Result<String, String>>,
{
    let mut buffer = String::new();
    let mut full = String::new();
    let mut handle = |line: &str, full: &mut String| -> Result<(), String> {
        let line = line.trim();
        if line.is_empty() {
            return Ok(());
        }
        if let Some(delta) = parse(line) {
            let delta = delta?;
            if !delta.is_empty() {
                full.push_str(&delta);
                let _ = on_delta.send(delta);
            }
        }
        Ok(())
    };
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("The response stream was interrupted: {error}"))?
    {
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(index) = buffer.find('\n') {
            let line: String = buffer.drain(..=index).collect();
            handle(&line, &mut full)?;
        }
    }
    handle(&buffer, &mut full)?;
    if full.trim().is_empty() {
        return Err("The assistant returned an empty response. Try again.".to_string());
    }
    Ok(full)
}

#[tauri::command]
async fn send_chat_message(
    messages: Vec<ChatMessage>,
    personality: String,
    provider: String,
    model: String,
    full_privacy: bool,
    screen_image: Option<String>,
    on_delta: Channel<String>,
) -> Result<String, String> {
    validate_privacy_provider(&provider, full_privacy)?;

    if messages.is_empty() || messages.len() > 20 {
        return Err("A conversation can include up to 20 recent messages.".to_string());
    }
    if messages.iter().any(|message| {
        (message.role != "user" && message.role != "assistant")
            || message.content.trim().is_empty()
            || message.content.len() > 8_000
    }) {
        return Err("A message was empty or exceeded the 8,000-character limit.".to_string());
    }

    let system_prompt = match personality.as_str() {
        "coach" => "You are Vela, a thoughtful, steady coach. Be warm, supportive, and practical. Help the user think clearly without being patronizing. Be concise unless they ask for depth.",
        "direct" => "You are Vela, a sharp and direct assistant. Lead with the answer, be concise, and skip filler. Be candid while staying respectful.",
        _ => "You are Vela, the user's clever, loyal wingmate. Be warm, quick-witted when it fits, encouraging but never fake. Keep answers useful and conversational; don't overdo jokes.",
    };

    let screen_image = screen_image.filter(|image| !image.trim().is_empty());
    if screen_image
        .as_ref()
        .is_some_and(|image| image.len() > 8_000_000 || !image.starts_with("/9j/"))
    {
        return Err("Screen snapshots must be JPEG images smaller than 6 MB.".to_string());
    }

    match provider.as_str() {
        "local" => {
            let tags = get_ollama_tags().await?;
            let installed = tags.models.iter().any(|candidate| candidate.name == model);
            if !installed {
                return Err(format!(
                    "The local model '{model}' isn't installed in Ollama. Install it, then refresh models."
                ));
            }
            if screen_image.is_some() && !model_supports_vision(&model).await? {
                return Err(
                    "This local model can't view images. Select an Ollama vision model to use screen context."
                        .to_string(),
                );
            }
            let mut request_messages = vec![json!({
                "role": "system",
                "content": system_prompt
            })];
            for message in &messages {
                let mut body = json!({
                    "role": message.role,
                    "content": message.content
                });
                let image = if message.role == "user" {
                    screen_image.as_ref().or(message.image.as_ref())
                } else {
                    None
                };
                if let Some(image) = image {
                    let images = body.as_object_mut().expect("chat message is an object");
                    images.insert("images".into(), json!([image]));
                }
                request_messages.push(body);
            }

            let response = http_client()
                .post(format!("{OLLAMA_BASE_URL}/api/chat"))
                .json(&json!({
                    "model": model,
                    "messages": request_messages,
                    "stream": true,"think": false,"keep_alive": "10m",
                    "options": {
                        "num_ctx": 4096,
                        "num_predict": 600,
                        "temperature": 0.65
                    }
                }))
                .timeout(Duration::from_secs(180))
                .send()
                .await
                .map_err(|error| format!("Couldn't reach local Ollama: {error}"))?;
            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                let message = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|value| value["error"].as_str().map(str::to_string));
                return Err(message.unwrap_or_else(|| format!("Ollama returned {status}.")));
            }
            stream_lines(response, &on_delta, |line| {
                let value: Value = serde_json::from_str(line).ok()?;
                if let Some(error) = value["error"].as_str() {
                    return Some(Err(error.to_string()));
                }
                value["message"]["content"]
                    .as_str()
                    .map(|text| Ok(text.to_string()))
            })
            .await
        }
        "openai" if full_privacy => Err("Full Privacy Mode blocked a cloud request.".to_string()),
        "openai" => {
            let api_key = get_api_key()?;
            let mut request_messages = vec![json!({
                "role": "system",
                "content": system_prompt
            })];
            request_messages.extend(messages.iter().map(|message| {
                let image = if message.role == "user" {
                    screen_image.as_ref().or(message.image.as_ref())
                } else {
                    None
                };

                if let Some(image) = image {
                    json!({
                        "role": message.role,
                        "content": [
                            { "type": "text", "text": message.content },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": format!("data:image/jpeg;base64,{image}"),
                                    "detail": "low"
                                }
                            }
                        ]
                    })
                } else {
                    json!({
                        "role": message.role,
                        "content": message.content
                    })
                }
            }));

            let response = http_client()
                .post("https://api.openai.com/v1/chat/completions")
                .bearer_auth(api_key)
                .json(&json!({
                    "model": "gpt-4o-mini",
                    "messages": request_messages,
                    "temperature": 0.7,
                    "max_tokens": 700,
                    "stream": true
                }))
                .send()
                .await
                .map_err(|error| format!("Couldn't reach OpenAI: {error}"))?;
            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                let message = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|value| value["error"]["message"].as_str().map(str::to_string));
                return Err(message.unwrap_or_else(|| format!("OpenAI returned {status}.")));
            }
            stream_lines(response, &on_delta, |line| {
                let data = line.strip_prefix("data:")?.trim();
                if data == "[DONE]" {
                    return None;
                }
                let value: Value = serde_json::from_str(data).ok()?;
                value["choices"][0]["delta"]["content"]
                    .as_str()
                    .map(|text| Ok(text.to_string()))
            })
            .await
        }
        _ => Err("Choose either OpenAI or a local Ollama model.".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            close_window,
            start_window_drag,
            set_always_on_top,
            set_window_expanded,
            get_api_key_status,
            save_api_key,
            delete_api_key,
            get_local_ai_status,
            synthesize_speech,
            transcribe_audio,
            send_chat_message
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Vela");
}
