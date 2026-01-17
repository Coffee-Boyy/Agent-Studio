import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;

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
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

