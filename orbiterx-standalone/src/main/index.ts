import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { is } from "@electron-toolkit/utils";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { autoUpdater } from "electron-updater";

type RpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

class AppServer {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { reject: (reason: Error) => void; resolve: (value: unknown) => void }>();
  private window?: BrowserWindow;

  async start(window: BrowserWindow) {
    this.window = window;
    const binary = process.env.ORBITERX_BINARY ?? this.binaryPath();
    this.child = spawn(binary, ["app-server", "--stdio"], { stdio: "pipe" });
    this.child.on("error", (error) => this.window?.webContents.send("orbiterx:event", { method: "server/error", params: { message: error.message } }));
    this.child.on("exit", (code) => this.window?.webContents.send("orbiterx:event", { method: "server/exited", params: { code } }));
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    createInterface({ input: this.child.stderr }).on("line", (line) => console.error(`[app-server] ${line}`));
    await this.request("initialize", { clientInfo: { name: "OrbiterX Standalone", version: app.getVersion() } });
    this.notify("initialized", {});
  }

  async request(method: string, params: unknown) {
    if (!this.child) throw new Error("OrbiterX app-server is not running.");
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ id, method, params });
    return result;
  }

  notify(method: string, params: unknown) {
    this.write({ method, params });
  }

  stop() {
    this.child?.kill();
    this.child = undefined;
  }

  private binaryPath() {
    const bundled = join(process.resourcesPath, "resources", process.platform === "win32" ? "orbiterx.exe" : "orbiterx");
    if (app.isPackaged && existsSync(bundled)) return bundled;
    return join(app.getAppPath(), "..", "orbiterx-rs", "target", "debug", process.platform === "win32" ? "orbiterx.exe" : "orbiterx");
  }

  private receive(line: string) {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "App-server request failed."));
      else pending.resolve(message.result);
      return;
    }
    this.window?.webContents.send("orbiterx:event", message);
  }

  private write(message: RpcMessage) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

const server = new AppServer();
let window: BrowserWindow | undefined;

/** Forward an update status event to the renderer over the same channel the
 * app-server uses. The renderer can surface these as it wishes. */
function emitUpdate(method: string, params: unknown) {
  window?.webContents.send("orbiterx:event", { method, params });
}

/** Auto-update from the electron-builder feed (`app-update.yml`, baked from the
 * `publish` config in package.json — the public release repo). Only runs when
 * packaged; dev builds have no feed to check. */
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => emitUpdate("update/checking", {}));
  autoUpdater.on("update-available", (info) =>
    emitUpdate("update/available", { version: info.version }),
  );
  autoUpdater.on("update-not-available", () => emitUpdate("update/not-available", {}));
  autoUpdater.on("download-progress", (progress) =>
    emitUpdate("update/progress", {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    emitUpdate("update/downloaded", { version: info.version }),
  );
  autoUpdater.on("error", (error) =>
    emitUpdate("update/error", { message: error.message }),
  );
  void autoUpdater.checkForUpdates();
}

async function createWindow() {
  window = new BrowserWindow({
    backgroundColor: "#111212",
    minHeight: 720,
    minWidth: 1080,
    titleBarStyle: "hiddenInset",
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: join(__dirname, "../preload/index.mjs") },
  });
  if (is.dev && process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(__dirname, "../renderer/index.html"));
  await server.start(window);
}

app.whenReady().then(() => {
  ipcMain.handle("orbiterx:request", (_event, method: string, params: unknown) => server.request(method, params));
  ipcMain.handle("orbiterx:pick-directory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.on("orbiterx:open-external", (_event, url: string) => void shell.openExternal(url));
  setupAutoUpdate();
  void createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => server.stop());
