import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("orbiterx", {
  onEvent(callback: (event: unknown) => void) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on("orbiterx:event", listener);
    return () => ipcRenderer.removeListener("orbiterx:event", listener);
  },
  pickDirectory: () => ipcRenderer.invoke("orbiterx:pick-directory") as Promise<string | undefined>,
  request: (method: string, params: unknown) => ipcRenderer.invoke("orbiterx:request", method, params),
});
