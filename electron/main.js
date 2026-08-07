/**
 * Optional Electron shell for a desktop window on Windows / Linux.
 * Run: npm run electron  (requires: npm i -D electron)
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0e18",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: "The Sad Wheel",
  });

  win.loadFile(path.join(__dirname, "..", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
