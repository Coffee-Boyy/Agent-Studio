const { contextBridge, ipcRenderer } = require("electron");

console.log("[preload] Loading agentStudio API...");

// Keep the surface area minimal. Add IPC safely here if/when the renderer needs it.
contextBridge.exposeInMainWorld("agentStudio", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
});

console.log("[preload] agentStudio API exposed");

