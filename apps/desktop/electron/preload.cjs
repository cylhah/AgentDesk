const { contextBridge, ipcRenderer } = require("electron");

/**
 * The only door from the renderer into the host.
 *
 * The window itself is a plain web page (contextIsolation on, nodeIntegration
 * off, sandbox on): it cannot touch `fs`, `child_process` or the session store.
 * Everything native goes through this explicit, promise-based surface — the
 * same shape our HTTP bridge exposes, so the HMI does not need two code paths.
 */
contextBridge.exposeInMainWorld("agentdeskShell", {
  info: () => ipcRenderer.invoke("shell:info"),
  resolveApproval: (decisions) => ipcRenderer.invoke("shell:resolve-approval", decisions),
});
