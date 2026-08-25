# OrbiterX

<div align="center">

# 🚀 The Next-Generation Multi-Agent AI Coding Platform

**OrbiterX is a fast, powerful, multi-agent coding platform designed to supercharge your software engineering workflow with autonomous agents, native IDE & desktop integration, and deep codebase intelligence.**

[![Release](https://img.shields.io/github/v/release/vasugeddavalasa31-dotcom/orbiterx-public-release?style=flat-square&color=indigo)](https://github.com/vasugeddavalasa31-dotcom/orbiterx-public-release/releases)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg?style=flat-square)](#download--installation)

</div>

---

## 🌟 What is OrbiterX?

OrbiterX is a local-first, multi-agent developer environment that connects directly to your codebase. It coordinates multiple specialized AI agent sub-processes (such as Architecture Planners, Codebase Researchers, Database Specialists, and Test Runners) to divide and conquer complex refactoring, feature implementation, automated testing, and error diagnosis.

---

## ✨ Key Features

- 🤖 **Autonomous Multi-Agent Orchestration**: Spawn and orchestrate concurrent specialized subagents that collaborate in real-time to solve complex multi-file tasks.
- ⚡ **Ultra-Fast Local Sidecars**: Powered by high-performance Rust backend engine (`orbiterx-app-server`) and companion stdio services (`orbiterx-mcp`) for zero-lag streaming and instant responses.
- 🛡️ **Secure Local Sandboxing**: Execute shell commands, tests, and builds with strict safety boundaries and granular permission controls.
- 🧠 **Deep Codebase Awareness**: Incremental indexing of repository layouts, AST symbol graphs, and dependencies for precise, context-aware code generation.
- 🔌 **Model Context Protocol (MCP)**: Native support for external MCP tools, browser automation, custom servers, and API integrations.
- 📱 **Remote Control & Live Monitoring**: Monitor active reasoning traces, view token telemetry, and manage development sessions seamlessly.

---

## 📥 Download & Installation

### 🪟 Windows Desktop (Installer & Auto-Updater)
Download the latest Windows setup installer from the [Releases Page](https://github.com/vasugeddavalasa31-dotcom/orbiterx-public-release/releases/latest):
* **`OrbiterX_x64-setup.exe`** — Includes built-in background auto-updater support.

### 🍎 macOS & 🐧 Linux (CLI)
Install the OrbiterX developer CLI via curl:
```bash
curl -fsSL https://raw.githubusercontent.com/vasugeddavalasa31-dotcom/rustorbiterx/main/scripts/install/install.sh | sh
```

### 🪟 Windows PowerShell (CLI)
Install the OrbiterX developer CLI via PowerShell:
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/vasugeddavalasa31-dotcom/rustorbiterx/main/scripts/install/install.ps1 | iex"
```

---

## 🚀 Getting Started

Launch OrbiterX inside any repository:
```bash
orbiterx
```

Or open the **OrbiterX Desktop** application to start chatting with intelligent agent pairs, exploring workspaces, and generating software at warp speed.

---

## 📄 License

This project is licensed under the **Apache License 2.0**. See the [LICENSE](LICENSE) file for details.
