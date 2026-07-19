#!/bin/bash

# Set "chatgpt.cliExecutable": "/Users/<USERNAME>/code/orbiterx/scripts/debug-orbiterx.sh" in VSCode settings to always get the 
# latest orbiterx-rs binary when debugging OrbiterX Extension.


set -euo pipefail

ORBITERX_RS_DIR=$(realpath "$(dirname "$0")/../orbiterx-rs")
(cd "$ORBITERX_RS_DIR" && cargo run --quiet --bin orbiterx -- "$@")