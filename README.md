# OrbiterX

> **OrbiterX** is a powerful multi-agent coding IDE and CLI designed to supercharge your software development workflow. Originally forked from OpenAI's Codex CLI, OrbiterX brings agentic coding directly to your terminal and local computer.

## Built with ❤️ in India
**Built on Codex CLI (Apache-2.0) with ❤️ in India**

---

## What is OrbiterX?

OrbiterX is a local-first, multi-agent coding assistant that works directly within your repository. It coordinates multiple specialized agent sub-processes (e.g., Codebase Researcher, Database Debugger, and Executor agents) to handle complex refactors, run tests, diagnose errors, and carry out large-scale implementation tasks on your local workspace.

## Features

- **Multi-Agent Orchestration**: Out-of-the-box support for spawning concurrent specialized subagents to divide and conquer complex developer tasks.
- **Local Sandbox Execution**: Secure process isolation using macOS Seatbelt (`sandbox-exec`), Linux Bubblewrap, and Windows Job Objects.
- **Deep Codebase Awareness**: Ingests your repository layout, indexing files, code symbols, and workspace dependencies incrementally.
- **Rich Interactive UI (TUI)**: A gorgeous Terminal User Interface powered by `ratatui` with terminal logs, file trees, composer editors, and image rendering.
- **IDE Extensions**: Seamlessly integrates with VS Code, Cursor, Windsurf, and other major code editors.
- **Tool & MCP Integration**: Extensible model interaction via the Model Context Protocol (MCP) and custom tool calls.

---

## Installation

### Mac or Linux
To install OrbiterX CLI on macOS or Linux, run:
```shell
curl -fsSL https://raw.githubusercontent.com/vasugeddavalasa31-dotcom/rustorbiterx/main/scripts/install/install.sh | sh
```

### Windows
To install OrbiterX CLI on Windows, run the following in PowerShell:
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/vasugeddavalasa31-dotcom/rustorbiterx/main/scripts/install/install.ps1 | iex"
```

### From Source
Alternatively, you can build OrbiterX directly from source:
```shell
# Clone the repository
git clone https://github.com/vasugeddavalasa31-dotcom/rustorbiterx.git
cd rustorbiterx/orbiterx-rs

# Build the release binary
cargo build --release
```

Once installed, simply run the `orbiterx` command to launch the CLI.

---

## Attribution

OrbiterX is a fork of OpenAI's Codex CLI (`openai/codex`). We are deeply grateful to the original creators and contributors of the Codex CLI codebase.

This project is licensed under the Apache-2.0 License. All original copyright notices, attributions, and license conditions have been preserved in accordance with the Apache-2.0 license. See [ATTRIBUTION.md](./ATTRIBUTION.md) and the [LICENSE](./LICENSE) file for more information.
