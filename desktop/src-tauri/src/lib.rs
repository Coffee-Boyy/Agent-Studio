// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, State, WindowEvent};

#[derive(Default)]
struct BackendState {
    child: Mutex<Option<Child>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackendStatus {
    url: String,
    running: bool,
    pid: Option<u32>,
}

fn backend_url() -> String {
    std::env::var("AGENT_STUDIO_BACKEND_URL").unwrap_or_else(|_| "http://127.0.0.1:37123".into())
}

fn backend_listen_addr() -> SocketAddr {
    // Keep this consistent with backend/README.md quickstart.
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 37123)
}

fn tcp_is_listening(addr: SocketAddr, timeout: Duration) -> bool {
    TcpStream::connect_timeout(&addr, timeout).is_ok()
}

fn child_is_running(child: &mut Child) -> bool {
    match child.try_wait() {
        Ok(Some(_status)) => false,
        Ok(None) => true,
        Err(_) => false,
    }
}

fn spawn_backend_process() -> Result<Child, String> {
    // Prefer an explicit command supplied by the host environment.
    // This makes dev + packaging flexible without hardcoding venv paths.
    //
    // Examples:
    // - mac/linux: AGENT_STUDIO_BACKEND_CMD="uvicorn agent_studio_backend.api:app --host 127.0.0.1 --port 37123"
    // - windows:   AGENT_STUDIO_BACKEND_CMD="python -m uvicorn agent_studio_backend.api:app --host 127.0.0.1 --port 37123"
    let cmd = std::env::var("AGENT_STUDIO_BACKEND_CMD").unwrap_or_else(|_| {
        // Reasonable default for local dev if python deps are installed.
        "python -m uvicorn agent_studio_backend.api:app --host 127.0.0.1 --port 37123".into()
    });

    // When the desktop app launches the backend, relax CORS because the UI will call over
    // localhost from a webview origin that can vary between dev/prod.
    //
    // This keeps the “Python is correct” assumption: we’re only setting env vars.
    let allow_origins = std::env::var("AGENT_STUDIO_ALLOW_CORS_ORIGINS").unwrap_or_else(|_| "*".into());

    #[cfg(target_os = "windows")]
    let mut c = {
        let mut c = Command::new("cmd");
        c.args(["/C", &cmd]);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut c = {
        let mut c = Command::new("sh");
        c.args(["-lc", &cmd]);
        c
    };

    // Ensure Python flushes logs promptly so they show up in `tauri dev`.
    // (Especially important when stdout/stderr are pipes instead of a tty.)
    let mut child = c
        .env("AGENT_STUDIO_ALLOW_CORS_ORIGINS", allow_origins)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed_to_spawn_backend: {e} (cmd={cmd})"))?;

    println!("[agent-studio] spawned backend (pid={}): {}", child.id(), cmd);

    if let Some(stdout) = child.stdout.take() {
        thread::Builder::new()
            .name("agent_studio_backend_stdout".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines().flatten() {
                    println!("[backend stdout] {line}");
                }
            })
            .ok();
    }

    if let Some(stderr) = child.stderr.take() {
        thread::Builder::new()
            .name("agent_studio_backend_stderr".into())
            .spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().flatten() {
                    eprintln!("[backend stderr] {line}");
                }
            })
            .ok();
    }

    Ok(child)
}

#[tauri::command]
fn backend_status(state: State<'_, BackendState>) -> Result<BackendStatus, String> {
    let url = backend_url();
    let mut child_guard = state.child.lock().map_err(|_| "backend_state_poisoned".to_string())?;

    let (running, pid) = if let Some(child) = child_guard.as_mut() {
        let running = child_is_running(child);
        let pid = if running { Some(child.id()) } else { None };
        (running, pid)
    } else {
        (false, None)
    };

    Ok(BackendStatus { url, running, pid })
}

#[tauri::command]
fn backend_start(state: State<'_, BackendState>) -> Result<BackendStatus, String> {
    let url = backend_url();
    let addr = backend_listen_addr();

    // If something is already listening, treat it as “running”.
    if tcp_is_listening(addr, Duration::from_millis(150)) {
        return Ok(BackendStatus {
            url,
            running: true,
            pid: None,
        });
    }

    // If we have a child but it died, clear it before respawning.
    {
        let mut child_guard =
            state.child.lock().map_err(|_| "backend_state_poisoned".to_string())?;
        if let Some(child) = child_guard.as_mut() {
            if !child_is_running(child) {
                *child_guard = None;
            }
        }
    }

    // Spawn backend process.
    let child = spawn_backend_process()?;
    {
        let mut child_guard =
            state.child.lock().map_err(|_| "backend_state_poisoned".to_string())?;
        *child_guard = Some(child);
    }

    // Wait for port to come up.
    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        if tcp_is_listening(addr, Duration::from_millis(150)) {
            let pid = state
                .child
                .lock()
                .ok()
                .and_then(|mut g| g.as_mut().map(|c| c.id()));
            return Ok(BackendStatus {
                url,
                running: true,
                pid,
            });
        }
        thread::sleep(Duration::from_millis(150));
    }

    Err("backend_start_timeout_waiting_for_port".into())
}

#[tauri::command]
fn backend_stop(state: State<'_, BackendState>) -> Result<BackendStatus, String> {
    let url = backend_url();
    let mut child_guard = state.child.lock().map_err(|_| "backend_state_poisoned".to_string())?;

    if let Some(mut child) = child_guard.take() {
        // Best-effort terminate; ignore errors (process may have already exited).
        let _ = child.kill();
        let _ = child.wait();
    }

    Ok(BackendStatus {
        url,
        running: false,
        pid: None,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendState::default())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Optional autostart so the UI can assume the Python backend is available.
            // Enable with: AGENT_STUDIO_AUTOSTART_BACKEND=1
            let autostart = std::env::var("AGENT_STUDIO_AUTOSTART_BACKEND")
                .ok()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);

            if autostart {
                let addr = backend_listen_addr();
                if !tcp_is_listening(addr, Duration::from_millis(150)) {
                    if let Ok(child) = spawn_backend_process() {
                        if let Ok(mut guard) = app.state::<BackendState>().child.lock() {
                            *guard = Some(child);
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            backend_start,
            backend_stop,
            backend_status
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // Ensure we don't orphan the Python backend when the app closes.
                if let Some(state) = window.app_handle().try_state::<BackendState>() {
                    if let Ok(mut child_guard) = state.child.lock() {
                        if let Some(mut child) = child_guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
