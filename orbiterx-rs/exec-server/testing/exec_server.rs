//! Minimal exec-server fixture for Bazel-only integration tests.
//!
//! Linking only exec-server avoids depending on the full OrbiterX CLI binary
//! when a test only needs a WebSocket executor endpoint.

use orbiterx_exec_server::ExecServerRuntimePaths;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let current_exe = std::env::current_exe()?;
    let runtime_paths =
        ExecServerRuntimePaths::new(current_exe, /*orbiterx_linux_sandbox_exe*/ None)?;
    orbiterx_exec_server::run_main("ws://127.0.0.1:0", runtime_paths).await
}
