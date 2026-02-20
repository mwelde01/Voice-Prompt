const { app, BrowserWindow, session, ipcMain } = require('electron');
const path    = require('path');
const http    = require('http');
const fs      = require('fs');
const { spawn } = require('child_process');

// Enable speech dispatcher on Linux for Web Speech API
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-speech-dispatcher');
}
app.commandLine.appendSwitch('no-sandbox');

/* ================================================================
   Local HTTP server
   Serving from http://127.0.0.1 (not file://) is required so that
   Chromium treats the page as a real HTTP origin.
   ================================================================ */
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
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}


/* ================================================================
   Windows native speech recognition via PowerShell + System.Speech
   Runs entirely offline — no Google API key, no internet needed.
   ================================================================ */
const PS_SPEECH_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$grammar = New-Object System.Speech.Recognition.DictationGrammar
$engine.LoadGrammar($grammar)
$engine.SetInputToDefaultAudioDevice()
$engine.add_SpeechRecognized({
    param($sender, $e)
    [Console]::WriteLine($e.Result.Text)
    [Console]::Out.Flush()
})
$engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
while ($true) { Start-Sleep -Seconds 1 }
`.trim();

let speechProcess = null;
let mainWin       = null;

function startNativeSpeech() {
  if (speechProcess || !mainWin || mainWin.isDestroyed()) return;

  const ps = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', PS_SPEECH_SCRIPT,
  ], { windowsHide: true });

  speechProcess = ps;
  ps.stdout.setEncoding('utf8');
  ps.stderr.setEncoding('utf8');

  let buf = '';
  ps.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();           // keep any incomplete last line
    for (const line of lines) {
      const text = line.trim();
      if (text && mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('speech:result', text);
      }
    }
  });

  ps.stderr.on('data', (chunk) => {
    const msg = chunk.trim();
    if (msg && mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('speech:error', msg);
    }
  });

  ps.on('exit', (code) => {
    speechProcess = null;
    // Notify renderer so it can show an error and attempt a restart
    if (code !== 0 && mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('speech:error', 'speech-process-exit');
    }
  });
}

function stopNativeSpeech() {
  if (speechProcess) {
    speechProcess.kill();
    speechProcess = null;
  }
}

// IPC handlers — registered once at module level
ipcMain.handle('speech:start', () => { startNativeSpeech(); });
ipcMain.handle('speech:stop',  () => { stopNativeSpeech(); });


/* ================================================================
   Browser window
   ================================================================ */
async function createWindow() {
  const { server, port } = await startLocalServer();

  mainWin = new BrowserWindow({
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

  // Auto-grant microphone permission
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'microphone');
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media' || permission === 'microphone';
  });

  mainWin.loadURL(`http://127.0.0.1:${port}`);

  mainWin.once('ready-to-show', () => { mainWin.show(); });

  mainWin.on('closed', () => {
    stopNativeSpeech();
    server.close();
    mainWin = null;
  });

  if (process.env.NODE_ENV === 'development') {
    mainWin.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
