//! Lifecycle for the bundled conversation engine (`orbiterx-app-server`).
//!
//! Dev runs the app-server separately via start.sh
//! (`orbiterx-app-server --listen ws://127.0.0.1:3001`); the packaged desktop
//! app bundles the same binary as a sidecar and spawns it here so the UI's
//! persistent WebSocket always has a server to talk to — no extra process
//! needed for beta/DMG users.

use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// The app-server's persistent WebSocket listener, hardcoded in the frontend
/// shell transport (`http://127.0.0.1:3001`).
const APP_SERVER_LISTEN: &str = "ws://127.0.0.1:3001";
const APP_SERVER_ADDR: &str = "127.0.0.1:3001";

/// Owns the spawned app-server child so it can be killed on app exit.
#[derive(Default)]
pub struct AppServerHandle(pub Mutex<Option<Child>>);

/// Resolve the bundled sidecar binary (sits next to the running executable in
/// both `tauri dev` and the packaged app).
fn sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        "orbiterx-app-server.exe"
    } else {
        "orbiterx-app-server"
    };
    let candidate = dir.join(name);
    candidate.exists().then_some(candidate)
}

/// True when something already listens on the app-server port — e.g. a dev
/// app-server started by start.sh. In that case we don't spawn a duplicate.
fn server_already_running() -> bool {
    let Ok(mut addrs) = APP_SERVER_ADDR.to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

/// Spawn the bundled app-server (idempotent). Called from Tauri setup before
/// the UI connects, so the workspace loads without a "Reconnecting…" loop.
pub fn spawn_app_server(app: &AppHandle) {
    if app.try_state::<AppServerHandle>().is_none() {
        app.manage(AppServerHandle::default());
    }

    let handle = app.state::<AppServerHandle>();
    let mut guard = match handle.0.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if guard.is_some() || server_already_running() {
        return;
    }

    let Some(path) = sidecar_path() else {
        tracing::warn!(
            "[app-server] sidecar binary not found next to the executable — skipping auto-start"
        );
        return;
    };

    match std::process::Command::new(&path)
        .arg("--listen")
        .arg(APP_SERVER_LISTEN)
        .spawn()
    {
        Ok(child) => {
            tracing::info!(
                "[app-server] started {} on {}",
                path.display(),
                APP_SERVER_LISTEN
            );
            *guard = Some(child);
        }
        Err(err) => {
            tracing::error!("[app-server] failed to start {}: {err}", path.display());
        }
    }
}

/// Kill the app-server child on app exit so it never outlives the UI.
pub fn stop_app_server(app: &AppHandle) {
    if let Some(handle) = app.try_state::<AppServerHandle>() {
        if let Ok(mut guard) = handle.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
                tracing::info!("[app-server] stopped");
            }
        }
    }
}
