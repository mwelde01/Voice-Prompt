const { app, BrowserWindow, session } = require('electron');
const path = require('path');

// Enable speech dispatcher on Linux for Web Speech API
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-speech-dispatcher');
}

// Disable sandbox on Linux if needed for microphone access
app.commandLine.appendSwitch('no-sandbox');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'VoicePrompt Desktop',
    backgroundColor: '#0d1117',
    show: false,
  });

  win.loadFile('index.html');

  // Auto-grant microphone permission for Web Speech API
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (permission === 'media' || permission === 'microphone') {
        callback(true);
      } else {
        callback(false);
      }
    }
  );

  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) => {
      if (permission === 'media' || permission === 'microphone') {
        return true;
      }
      return false;
    }
  );

  win.once('ready-to-show', () => {
    win.show();
  });

  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
