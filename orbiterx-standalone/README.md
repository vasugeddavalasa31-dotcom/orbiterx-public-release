# OrbiterX Standalone

An Electron and SolidJS desktop client for the local `orbiterx app-server` JSON-RPC interface.

## Development

Build the OrbiterX CLI first, then start the desktop client from the repository root:

```bash
cd orbiterx-rs
cargo build -p orbiterx-cli
cd ..
pnpm --dir orbiterx-standalone dev
```

The client looks for `orbiterx-rs/target/debug/orbiterx` during development. To use another binary, set `ORBITERX_BINARY` to its absolute path before starting Electron.

The provider dialog applies an OpenRouter, Ollama, or OpenAI-compatible configuration to new tasks only. API keys are not persisted by the renderer.

## Package

```bash
pnpm --dir orbiterx-standalone package
```

Put the release `orbiterx` binary in `orbiterx-standalone/resources/` before packaging. `electron-builder` will bundle it as an application resource.
