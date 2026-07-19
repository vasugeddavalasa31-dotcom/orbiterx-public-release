#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    orbiterx_code_mode_host::run_stdio().await
}
