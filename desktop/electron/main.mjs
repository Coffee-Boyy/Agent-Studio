import { app, BrowserWindow, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;

let sidecarProcess = null;

function resolveBackendRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend");
  }
  return path.join(app.getAppPath(), "..", "backend");
}

function resolveBackendPath(backendRoot) {
  if (app.isPackaged) {
    return backendRoot;
  }
  return path.join(backendRoot, "src");
}

function resolveEmbeddedPythonPath() {
  const pythonRoot = path.join(process.resourcesPath, "python");
  if (process.platform === "win32") {
    return path.join(pythonRoot, "python.exe");
  }
  const python3Path = path.join(pythonRoot, "bin", "python3");
  if (fs.existsSync(python3Path)) {
    return python3Path;
  }
  return path.join(pythonRoot, "bin", "python");
}

function resolveDevPythonBinary(backendRoot) {
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(path.join(backendRoot, ".venv", "Scripts", "python.exe"));
  } else {
    candidates.push(path.join(backendRoot, ".venv", "bin", "python3"));
    candidates.push(path.join(backendRoot, ".venv", "bin", "python"));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

function resolvePythonBinary(backendRoot) {
  if (process.env.AGENT_STUDIO_PYTHON) {
    return process.env.AGENT_STUDIO_PYTHON;
  }
  if (app.isPackaged) {
    return resolveEmbeddedPythonPath();
  }
  return resolveDevPythonBinary(backendRoot);
}

function startSidecar() {
  if (sidecarProcess) return;

  const backendRoot = resolveBackendRoot();
  const backendPath = resolveBackendPath(backendRoot);
  const pythonBinary = resolvePythonBinary(backendRoot);
  if (app.isPackaged && !fs.existsSync(pythonBinary)) {
    console.warn(`[sidecar] Embedded Python not found at ${pythonBinary}`);
    return;
  }
  if (!app.isPackaged && path.isAbsolute(pythonBinary) && !fs.existsSync(pythonBinary)) {
    console.warn(`[sidecar] Python not found at ${pythonBinary}`);
    return;
  }
  const env = {
    ...process.env,
    PYTHONPATH: [backendPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    AGENT_STUDIO_HOST: process.env.AGENT_STUDIO_HOST || "127.0.0.1",
    AGENT_STUDIO_PORT: process.env.AGENT_STUDIO_PORT || "37123",
  };

  sidecarProcess = spawn(pythonBinary, ["-m", "agent_studio_backend.main"], {
    env,
    cwd: backendRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  sidecarProcess.stdout?.on("data", (data) => {
    console.log(`[sidecar] ${data.toString().trimEnd()}`);
  });
  sidecarProcess.stderr?.on("data", (data) => {
    console.warn(`[sidecar] ${data.toString().trimEnd()}`);
  });
  sidecarProcess.on("error", (err) => {
    console.error(`[sidecar] failed to start: ${err.message}`);
  });
  sidecarProcess.on("exit", (code, signal) => {
    console.log(`[sidecar] exited (code=${code} signal=${signal})`);
    sidecarProcess = null;
  });
}

function stopSidecar() {
  if (!sidecarProcess) return;
  sidecarProcess.kill();
  sidecarProcess = null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Open external links in the user’s browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (e, url) => {
    const isDev = Boolean(DEV_RENDERER_URL);
    const allowed = isDev ? url.startsWith(DEV_RENDERER_URL) : url.startsWith("file://");
    if (!allowed) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  if (DEV_RENDERER_URL) {
    win.loadURL(DEV_RENDERER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // `app.getAppPath()` points at the packaged app root (asar or folder).
    win.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  startSidecar();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopSidecar();
});

