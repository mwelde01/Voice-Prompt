const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const http = require('http');
const fs   = require('fs');

// Enable speech dispatcher on Linux for Web Speech API
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-speech-dispatcher');
}

// Disable sandbox on Linux if needed for microphone access
app.commandLine.appendSwitch('no-sandbox');

// ── Local HTTP server ──────────────────────────────────────────────
// The Web Speech API is blocked when loaded from file:// in Electron.
// Serving from localhost gives Chromium a proper HTTP origin so Google's
// speech servers accept the connection.
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
};

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url      = req.url === '/' ? '/index.html' : req.url;
      const filePath = path.join(__dirname, url.split('?')[0]);

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
        res.end(data);
      });
    });

    // Port 0 lets the OS pick a free port automatically
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

// ── Window ────────────────────────────────────────────────────────
async function createWindow() {
  const { server, port } = await startLocalServer();

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

  win.loadURL(`http://127.0.0.1:${port}`);

  win.once('ready-to-show', () => {
    win.show();
  });

  // Stop the local server when the window is closed
  win.on('closed', () => {
    server.close();
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
