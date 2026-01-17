import { contextBridge } from "electron";

// Keep the surface area minimal. Add IPC safely here if/when the renderer needs it.
contextBridge.exposeInMainWorld("agentStudio", {});

