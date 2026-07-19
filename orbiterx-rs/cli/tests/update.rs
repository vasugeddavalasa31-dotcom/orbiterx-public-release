use anyhow::Result;
use predicates::str::contains;
use std::path::Path;
use tempfile::TempDir;

fn orbiterx_command(orbiterx_home: &Path) -> Result<assert_cmd::Command> {
    let mut cmd = assert_cmd::Command::new(orbiterx_utils_cargo_bin::cargo_bin("orbiterx")?);
    cmd.env("ORBITERX_HOME", orbiterx_home);
    Ok(cmd)
}

#[cfg(debug_assertions)]
#[tokio::test]
async fn update_does_not_start_interactive_prompt() -> Result<()> {
    let orbiterx_home = TempDir::new()?;

    orbiterx_command(orbiterx_home.path())?
        .arg("update")
        .assert()
        .failure()
        .stderr(contains(
            "`orbiterx update` is not available in debug builds",
        ));

    Ok(())
}
