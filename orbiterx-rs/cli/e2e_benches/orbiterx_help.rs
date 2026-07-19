#![allow(clippy::expect_used)]

use std::process::Command;

use divan::Bencher;

fn main() {
    divan::main();
}

/// Exercises the Bazel-backed end-to-end benchmark path with a cheap,
/// deterministic OrbiterX invocation. Richer scenarios can add separate
/// benchmark binaries without making the shared harness depend on them.
#[divan::bench(sample_count = 20, sample_size = 1)]
fn orbiterx_help(bencher: Bencher) {
    let orbiterx = orbiterx_utils_cargo_bin::cargo_bin("orbiterx")
        .expect("orbiterx binary should be available through Bazel runfiles");

    bencher.bench_local(move || {
        let output = Command::new(&orbiterx)
            .arg("--help")
            .output()
            .expect("orbiterx --help should run");
        assert!(output.status.success(), "orbiterx --help should succeed");
    });
}
