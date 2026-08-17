import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import "./styles.css";

type Thread = { id: string; name?: string; cwd?: string; updatedAt?: number };
type Message = { author: "assistant" | "user"; text: string };
type Event = { method?: string; params?: Record<string, unknown> };
type Provider = { apiKey: string; baseUrl: string; type: string };
type Model = { id: string; model: string; displayName: string; description: string; isDefault: boolean; supportedReasoningEfforts: { reasoningEffort: string; description: string }[] };
type Entry = { fileName: string; isDirectory: boolean; isFile: boolean };
type ToolCall = { id: string; name: string; args: string; status: "running" | "completed" | "error"; output: string; };

function App() {
  const [workspace, setWorkspace] = createSignal<string>();
  const [thread, setThread] = createSignal<Thread>();
  const [threads, setThreads] = createSignal<Thread[]>([]);
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [prompt, setPrompt] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [tools, setTools] = createSignal<ToolCall[]>([]);
  const [notice, setNotice] = createSignal("Choose a workspace to begin.");
  const [activity, setActivity] = createSignal<string[]>([]);
  const [provider, setProvider] = createSignal<Provider>({ apiKey: "", baseUrl: "https://openrouter.ai/api/v1", type: "openrouter" });
  const [providerOpen, setProviderOpen] = createSignal(false);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [models, setModels] = createSignal<Model[]>([]);
  const [modelOpen, setModelOpen] = createSignal(false);
  const [model, setModel] = createSignal<Model>();
  const [panel, setPanel] = createSignal<"files" | "terminal" | "changes">("files");
  const [files, setFiles] = createSignal<Entry[]>([]);

  onMount(() => {
    const unsubscribe = window.orbiterx.onEvent((value) => onEvent(value as Event));
    void refreshThreads();
    void loadModels();
    onCleanup(unsubscribe);
  });

  async function refreshThreads() {
    try {
      const result = await window.orbiterx.request("thread/list", { limit: 30 }) as { data?: Thread[] };
      setThreads(result.data ?? []);
    } catch {
      setNotice("Waiting for the OrbiterX app-server…");
    }
  }

  async function loadModels() {
    try {
      const result = await window.orbiterx.request("model/list", { limit: 50 }) as { data?: Model[] };
      const available = result.data ?? [];
      setModels(available);
      setModel(available.find((item) => item.isDefault) ?? available[0]);
    } catch {
      setNotice("Model catalog will be available when the provider is connected.");
    }
  }

  async function openWorkspace() {
    const cwd = await window.orbiterx.pickDirectory();
    if (!cwd) return;
    setWorkspace(cwd);
    void loadFiles(cwd);
    await newThread(cwd);
  }

  async function loadFiles(path: string) {
    try {
      const result = await window.orbiterx.request("fs/readDirectory", { path }) as { entries?: Entry[] };
      setFiles((result.entries ?? []).sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || left.fileName.localeCompare(right.fileName)).slice(0, 80));
    } catch {
      setFiles([]);
    }
  }

  async function newThread(cwd = workspace()) {
    if (!cwd) return openWorkspace();
    setBusy(true);
    setMessages([]);
    setActivity([]);
    try {
      const config = provider();
      const result = await window.orbiterx.request("thread/start", {
        cwd,
        model: model()?.model,
        config: {
          api_key: config.apiKey || undefined,
          base_url: config.baseUrl || undefined,
          provider_type: config.type || undefined,
        },
      }) as { thread: Thread };
      setThread(result.thread);
      setWorkspace(cwd);
      setThreads((current) => [result.thread, ...current.filter((item) => item.id !== result.thread.id)]);
      setNotice("Ready when you are.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to start a thread.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const text = prompt().trim();
    if (!text || !thread() || busy()) return;
    setPrompt("");
    setMessages((current) => [...current, { author: "user", text }, { author: "assistant", text: "" }]);
    setBusy(true);
    setNotice("OrbiterX is working…");
    try {
      await window.orbiterx.request("turn/start", {
        threadId: thread()!.id,
        input: [{ type: "text", text }],
      });
    } catch (error) {
      setBusy(false);
      setNotice(error instanceof Error ? error.message : "Unable to start that turn.");
    }
  }

  function onEvent(event: Event) {
    console.log("[EVENT]", JSON.stringify(event));
    const params = event.params ?? {};
    if (event.method === "turn/started") {
      setTools([]);
      setActivity([]);
      return;
    }
    if (event.method === "item/started") {
      const fc = params.function_call as { name?: string; arguments?: string } | undefined;
      if (params.type === "function_call" && fc) {
        setTools((current) => [...current, {
          id: params.id as string,
          name: fc.name ?? "tool",
          args: fc.arguments ?? "",
          status: "running",
          output: "",
        }]);
      }
      return;
    }
    if (event.method === "item/completed") {
      setTools((current) => current.map((t) => t.id === params.id ? { ...t, status: "completed" } : t));
      return;
    }
    if (event.method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      setMessages((current) => current.map((m, i) => i === current.length - 1 && m.author === "assistant" ? { ...m, text: m.text + delta } : m));
      return;
    }
    if (event.method === "item/commandExecution/outputDelta" || event.method === "item/fileChange/outputDelta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      const itemId = (params.itemId ?? params.id) as string;
      setTools((current) => current.map((t) => t.id === itemId ? { ...t, output: t.output + delta } : t));
      return;
    }
    if (event.method === "turn/completed") {
      setBusy(false);
      setNotice("Turn complete.");
      void refreshThreads();
      return;
    }
    if (event.method === "server/error" || event.method === "server/exited") {
      setBusy(false);
      setNotice(typeof params.message === "string" ? params.message : "The app-server stopped.");
    }
  }

  return <main class="shell">
    <aside class="rail glass">
      <div class="brand"><span class="orb">✦</span><span>orbiterx</span></div>
      <button class="new" onClick={() => void newThread()}><span>＋</span> New task</button>
      <button class="workspace" onClick={() => void openWorkspace()} title="Choose workspace">
        <span class="folder">⌘</span><span>{workspace()?.split("/").at(-1) ?? "Open workspace"}</span>
      </button>
      <div class="section-label">RECENT TASKS</div>
      <nav class="threads">
        <For each={threads().slice(0, 8)}>{(item) =>
          <button classList={{ selected: item.id === thread()?.id }} onClick={() => setNotice("Resume support is next in the app-server client.")}>
            <span class="thread-dot" /><span>{item.name ?? item.cwd?.split("/").at(-1) ?? "Untitled task"}</span>
          </button>
        }</For>
      </nav>
      <div class="rail-foot"><span class="status-dot" /> App server <span class="muted">connected</span></div>
    </aside>

    <section class="conversation">
      <header class="topbar glass">
        <div><div class="eyebrow">WORKSPACE</div><strong>{workspace() ?? "No workspace selected"}</strong></div>
        <div class="top-actions"><button onClick={() => setProviderOpen(true)} title="Configure providers">⌘ Providers</button><button onClick={() => setSettingsOpen(true)} title="Settings">⚙</button></div>
      </header>

      <div class="transcript">
        <Show when={thread()} fallback={<Welcome onOpen={() => void openWorkspace()} />}>
          <For each={messages()}>{(message, index) => <>
            <article class={`message ${message.author}`}>
              <div class="avatar">{message.author === "user" ? "Y" : "✦"}</div>
              <div class="bubble">{message.text}</div>
            </article>
            <Show when={message.author === "assistant" && index() === messages().length - 1}>
              <For each={tools()}>{(tool) =>
                <div classList={{ tool: true, glass: true, running: tool.status === "running", completed: tool.status === "completed", error: tool.status === "error" }}>
                  <div class="tool-header">
                    <span class="tool-icon">{tool.status === "running" ? "⏳" : tool.status === "error" ? "✗" : "✓"}</span>
                    <span class="tool-name">{tool.name}</span>
                    <Show when={tool.status === "running"}><span class="tool-pulse" /></Show>
                  </div>
                  <Show when={tool.args}><pre class="tool-args">{(() => { try { return JSON.stringify(JSON.parse(tool.args), null, 2); } catch { return tool.args; } })()}</pre></Show>
                  <Show when={tool.output}><pre class="tool-output">{tool.output}</pre></Show>
                </div>
              }</For>
              <Show when={!tools().length && !messages()[messages().length - 1]?.text && busy()}>
                <div class="thinking-indicator"><span class="pulse" />Thinking</div>
              </Show>
            </Show>
          </>}</For>
        </Show>
      </div>

      <footer class="composer glass">
        <textarea value={prompt()} onInput={(event) => setPrompt(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} disabled={!thread() || busy()} placeholder={thread() ? "Ask OrbiterX anything about this workspace…" : "Open a workspace to start"} rows="1" />
        <div class="composer-actions"><div class="composer-tools"><button class="tool-button" title="Attach files">＋</button><button class="model-button" onClick={() => setModelOpen(!modelOpen())}><span class="model-mark">✦</span>{model()?.displayName ?? "Select model"}<span>⌄</span></button><button class="tool-button">Workspace write ⌄</button></div><span class="notice">{notice()}</span><button class="send" onClick={() => void submit()} disabled={!prompt().trim() || !thread() || busy()}>↑</button></div>
        <Show when={modelOpen()}><div class="model-menu glass"><div class="menu-title">Select model</div><For each={models()}>{(item) => <button classList={{ active: item.id === model()?.id }} onClick={() => { setModel(item); setModelOpen(false); }}><span class="model-mark">✦</span><span><strong>{item.displayName}</strong><small>{item.description}</small></span><Show when={item.id === model()?.id}><b>✓</b></Show></button>}</For><Show when={!models().length}><p>No models yet. Configure a provider first.</p></Show></div></Show>
      </footer>
    </section>

    <aside class="inspector glass">
      <div class="panel-tabs"><button classList={{ active: panel() === "files" }} onClick={() => setPanel("files")}>Files</button><button classList={{ active: panel() === "terminal" }} onClick={() => setPanel("terminal")}>Terminal</button><button classList={{ active: panel() === "changes" }} onClick={() => setPanel("changes")}>Changes</button></div>
      <Show when={panel() === "files"}><div class="tree-root"><span>⌄</span><strong>{workspace()?.split("/").at(-1) ?? "Workspace"}</strong></div><Show when={files().length} fallback={<p class="empty">Open a workspace to browse its project files.</p>}><div class="file-list"><For each={files()}>{(file) => <button onClick={() => file.isDirectory && workspace() && void loadFiles(`${workspace()}/${file.fileName}`)}><span>{file.isDirectory ? "›" : "·"}</span><span>{file.isDirectory ? "▱" : "▹"}</span>{file.fileName}</button>}</For></div></Show></Show>
      <Show when={panel() === "terminal"}><div class="terminal"><span class="terminal-prompt">orbiterx</span><span class="terminal-cursor" /></div><p class="empty">Command output from OrbiterX tools appears here.</p></Show>
      <Show when={panel() === "changes"}><div class="inspector-title">Working changes</div><p class="empty">Edits made during this task will be grouped here.</p></Show>
      <div class="divider" />
      <div class="inspector-title">Live activity</div>
      <Show when={activity().length} fallback={<p class="empty">Tool activity, file changes, and approvals will appear here.</p>}>
        <For each={activity()}>{(item) => <div class="event"><span>↳</span>{item}</div>}</For>
      </Show>
      <div class="inspector-foot">OrbiterX Standalone<br /><span>Local agent interface</span></div>
    </aside>
    <Show when={providerOpen()}><ProviderDialog provider={provider()} onClose={() => setProviderOpen(false)} onSave={(value) => { setProvider(value); setProviderOpen(false); setNotice("Provider settings will apply to the next task."); }} /></Show>
    <Show when={settingsOpen()}><SettingsDialog onClose={() => setSettingsOpen(false)} onProviders={() => { setSettingsOpen(false); setProviderOpen(true); }} /></Show>
  </main>;
}

function Welcome(props: { onOpen: () => void }) {
  return <div class="welcome"><div class="welcome-orb">✦</div><p class="eyebrow">ORBITERX STANDALONE</p><h1>Build from a calmer<br />command center.</h1><p class="welcome-copy">Choose a project and OrbiterX will work directly in your workspace with your configured BYOK provider.</p><button class="open-primary" onClick={props.onOpen}>Open a workspace <span>→</span></button><div class="shortcuts"><span><kbd>⌘</kbd> <kbd>O</kbd> Open workspace</span><span><kbd>↵</kbd> Send a task</span></div></div>;
}

function ProviderDialog(props: { provider: Provider; onClose: () => void; onSave: (provider: Provider) => void }) {
  const [value, setValue] = createSignal(props.provider);
  return <div class="modal-backdrop" onMouseDown={props.onClose}>
    <section class="provider-dialog glass" onMouseDown={(event) => event.stopPropagation()}>
      <div><p class="eyebrow">BRING YOUR OWN KEY</p><h2>Provider connection</h2><p class="dialog-copy">Credentials remain in this running desktop session and are passed only to the local OrbiterX app-server.</p></div>
      <label>Provider type<select value={value().type} onChange={(event) => setValue({ ...value(), type: event.currentTarget.value })}><option value="openrouter">OpenRouter</option><option value="ollama">Ollama</option><option value="direct">OpenAI-compatible</option></select></label>
      <label>Base URL<input value={value().baseUrl} onInput={(event) => setValue({ ...value(), baseUrl: event.currentTarget.value })} placeholder="https://openrouter.ai/api/v1" /></label>
      <label>API key <span>(optional for Ollama)</span><input type="password" value={value().apiKey} onInput={(event) => setValue({ ...value(), apiKey: event.currentTarget.value })} placeholder="sk-or-v1-…" /></label>
      <div class="dialog-actions"><button class="cancel" onClick={props.onClose}>Cancel</button><button class="open-primary" onClick={() => props.onSave(value())}>Save for this session</button></div>
    </section>
  </div>;
}

function SettingsDialog(props: { onClose: () => void; onProviders: () => void }) {
  const [tab, setTab] = createSignal("general");
  return <div class="modal-backdrop" onMouseDown={props.onClose}><section class="settings-dialog glass" onMouseDown={(event) => event.stopPropagation()}>
    <aside><p class="eyebrow">ORBITERX</p><h2>Settings</h2><nav><button classList={{ active: tab() === "general" }} onClick={() => setTab("general")}>⚙ General</button><button classList={{ active: tab() === "models" }} onClick={() => setTab("models")}>✦ Models</button><button classList={{ active: tab() === "providers" }} onClick={() => setTab("providers")}>⌘ Providers</button><button classList={{ active: tab() === "permissions" }} onClick={() => setTab("permissions")}>⌁ Permissions</button></nav><span class="settings-version">OrbiterX Standalone · v0.1.0</span></aside>
    <div class="settings-content"><button class="close" onClick={props.onClose}>×</button><Show when={tab() === "general"}><h3>General</h3><Setting label="Theme" value="Dark" /><Setting label="Terminal font size" value="14 px" /><Setting label="Send on Enter" value="Enabled" /></Show><Show when={tab() === "models"}><h3>Models</h3><p>Choose a model from the composer for each task. The available catalog comes directly from your current provider.</p></Show><Show when={tab() === "providers"}><h3>Providers</h3><p>Connect OpenRouter, Ollama, or an OpenAI-compatible endpoint with your own key.</p><button class="open-primary" onClick={props.onProviders}>Configure provider</button></Show><Show when={tab() === "permissions"}><h3>Permissions</h3><p>OrbiterX requests approval before commands or edits according to the active workspace policy.</p><Setting label="Default mode" value="Workspace write" /><Setting label="Command approvals" value="Ask when needed" /></Show></div>
  </section></div>;
}

function Setting(props: { label: string; value: string }) { return <div class="setting"><span>{props.label}</span><button>{props.value} ⌄</button></div>; }

render(() => <App />, document.getElementById("root")!);
