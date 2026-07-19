<p align="center"><strong>OrbiterX CLI</strong> is a coding agent from OpenAI that runs locally on your computer.
<p align="center">
  <img src="https://github.com/openai/orbiterx/blob/main/.github/orbiterx-cli-splash.png" alt="OrbiterX CLI splash" width="80%" />
</p>
</br>
If you want OrbiterX in your code editor (VS Code, Cursor, Windsurf), <a href="https://developers.openai.com/orbiterx/ide">install in your IDE.</a>
</br>If you want the desktop app experience, run <code>orbiterx app</code> or visit <a href="https://chatgpt.com/orbiterx?app-landing-page=true">the OrbiterX App page</a>.
</br>If you are looking for the <em>cloud-based agent</em> from OpenAI, <strong>OrbiterX Web</strong>, go to <a href="https://chatgpt.com/orbiterx">chatgpt.com/orbiterx</a>.</p>

---

## Quickstart

### Installing and running OrbiterX CLI

Run the following on Mac or Linux to install OrbiterX CLI:

```shell
curl -fsSL https://chatgpt.com/orbiterx/install.sh | sh
```

Run the following on Windows to install OrbiterX CLI:

```shell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/orbiterx/install.ps1 | iex"
```

OrbiterX CLI can also be installed via the following package managers:

```shell
# Install using npm
npm install -g @openai/orbiterx
```

```shell
# Install using Homebrew
brew install --cask orbiterx
```

Then simply run `orbiterx` to get started.

<details>
<summary>You can also go to the <a href="https://github.com/openai/orbiterx/releases/latest">latest GitHub Release</a> and download the appropriate binary for your platform.</summary>

Each GitHub Release contains many executables, but in practice, you likely want one of these:

- macOS
  - Apple Silicon/arm64: `orbiterx-aarch64-apple-darwin.tar.gz`
  - x86_64 (older Mac hardware): `orbiterx-x86_64-apple-darwin.tar.gz`
- Linux
  - x86_64: `orbiterx-x86_64-unknown-linux-musl.tar.gz`
  - arm64: `orbiterx-aarch64-unknown-linux-musl.tar.gz`

Each archive contains a single entry with the platform baked into the name (e.g., `orbiterx-x86_64-unknown-linux-musl`), so you likely want to rename it to `orbiterx` after extracting it.

</details>

### Using OrbiterX with your ChatGPT plan

Run `orbiterx` and select **Sign in with ChatGPT**. We recommend signing into your ChatGPT account to use OrbiterX as part of your Plus, Pro, Business, Edu, or Enterprise plan. [Learn more about what's included in your ChatGPT plan](https://help.openai.com/en/articles/11369540-orbiterx-in-chatgpt).

You can also use OrbiterX with an API key, but this requires [additional setup](https://developers.openai.com/orbiterx/auth#sign-in-with-an-api-key).

## Docs

- [**OrbiterX Documentation**](https://developers.openai.com/orbiterx)
- [**Contributing**](./docs/contributing.md)
- [**Installing & building**](./docs/install.md)
- [**Open source fund**](./docs/open-source-fund.md)

This repository is licensed under the [Apache-2.0 License](LICENSE).
