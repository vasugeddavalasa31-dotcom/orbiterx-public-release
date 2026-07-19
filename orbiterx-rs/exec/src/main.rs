//! Entry-point for the `orbiterx-exec` binary.
//!
//! When this CLI is invoked normally, it parses the standard `orbiterx-exec` CLI
//! options and launches the non-interactive OrbiterX agent. However, if it is
//! invoked with arg0 as `orbiterx-linux-sandbox`, we instead treat the invocation
//! as a request to run the logic for the standalone `orbiterx-linux-sandbox`
//! executable (i.e., parse any -s args and then run a *sandboxed* command under
//! Landlock + seccomp.
//!
//! This allows us to ship a completely separate set of functionality as part
//! of the `orbiterx-exec` binary.
use clap::Parser;
use orbiterx_arg0::Arg0DispatchPaths;
use orbiterx_arg0::arg0_dispatch_or_else;
use orbiterx_exec::Cli;
use orbiterx_exec::run_main;
use orbiterx_utils_cli::CliConfigOverrides;

#[derive(Parser, Debug)]
struct TopCli {
    #[clap(flatten)]
    config_overrides: CliConfigOverrides,

    #[clap(flatten)]
    inner: Cli,
}

fn main() -> anyhow::Result<()> {
    arg0_dispatch_or_else(|arg0_paths: Arg0DispatchPaths| async move {
        let top_cli = TopCli::parse();
        // Merge root-level overrides into inner CLI struct so downstream logic remains unchanged.
        let mut inner = top_cli.inner;
        inner
            .config_overrides
            .prepend_root_overrides(top_cli.config_overrides);

        run_main(inner, arg0_paths).await?;
        Ok(())
    })
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
