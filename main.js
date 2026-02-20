const { app, BrowserWindow, session, ipcMain } = require('electron');
const path    = require('path');
const http    = require('http');
const fs      = require('fs');
const os      = require('os');
const { spawn } = require('child_process');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-speech-dispatcher');
}
app.commandLine.appendSwitch('no-sandbox');

/* ================================================================
   Local HTTP server — serves files from http://127.0.0.1:<port>
   so Chromium has a proper HTTP origin (file:// breaks speech APIs)
   ================================================================ */
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const filePath = path.join(__dirname, (req.url === '/' ? '/index.html' : req.url).split('?')[0]);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}


/* ================================================================
   Windows native speech — PowerShell + inline C# + System.Speech

   WHY INLINE C#:
   PowerShell script-block delegates (add_SpeechRecognized({...}))
   need the PowerShell main-thread runspace to be free to execute.
   But our main thread is blocked by "while($true){Start-Sleep}",
   so every recognised phrase just queues silently and nothing runs.

   C# lambdas compile to real delegates that fire on the engine's
   own audio thread and write to stdout with no PS runspace needed.

   We write the script to a temp .ps1 file so that:
     • Newlines survive Windows argument quoting (-Command breaks them)
     • -ExecutionPolicy Bypass applies to the whole file cleanly
   ================================================================ */
const PS_SCRIPT_PATH = path.join(os.tmpdir(), 'voiceprompt-speech.ps1');

// The here-string closing "@ MUST start at column 0 in the file.
const PS_SCRIPT_LINES = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'try {',
  '    Add-Type -AssemblyName System.Speech',
  // Grab the loaded assembly path so Add-Type can reference it
  '    $dll = [System.Speech.Recognition.SpeechRecognitionEngine].Assembly.Location',
  '    $src = @"',
  'using System;',
  'using System.Speech.Recognition;',
  'public static class VoiceRec {',
  '    static SpeechRecognitionEngine _e;',
  '    public static void Start() {',
  '        _e = new SpeechRecognitionEngine();',
  '        _e.LoadGrammar(new DictationGrammar());',
  '        _e.SetInputToDefaultAudioDevice();',
  '        _e.SpeechRecognized += (s, ev) => {',
  '            Console.WriteLine(ev.Result.Text);',
  '            Console.Out.Flush();',
  '        };',
  '        _e.RecognizeAsync(RecognizeMode.Multiple);',
  '    }',
  '}',
  '"@',                                         // must be at column 0
  '    Add-Type -TypeDefinition $src -ReferencedAssemblies $dll',
  '    [VoiceRec]::Start()',
  '    [Console]::Error.WriteLine("READY")',
  '    [Console]::Error.Flush()',
  // Keep the process alive; C# callbacks run on the engine's own thread
  '    while ($true) { [System.Threading.Thread]::Sleep(1000) }',
  '} catch {',
  '    [Console]::Error.WriteLine("ERROR: " + $_.Exception.Message)',
  '    [Console]::Error.Flush()',
  '    exit 1',
  '}',
];

let speechProcess = null;
let mainWin       = null;
let speechKilled  = false;   // tracks intentional kills so exit handler stays quiet

function startNativeSpeech() {
  if (speechProcess || process.platform !== 'win32') return;
  if (!mainWin || mainWin.isDestroyed()) return;

  // Write script to a temp file — avoids command-line length / newline issues
  try {
    fs.writeFileSync(PS_SCRIPT_PATH, PS_SCRIPT_LINES.join('\r\n'), 'utf8');
  } catch (err) {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('speech:error', 'Cannot write script: ' + err.message);
    }
    return;
  }

  const ps = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',   // required on restricted corporate/university machines
    '-File', PS_SCRIPT_PATH,
  ], { windowsHide: true });

  speechProcess = ps;
  speechKilled  = false;
  ps.stdout.setEncoding('utf8');
  ps.stderr.setEncoding('utf8');

  let buf = '';
  ps.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const text = line.trim();
      if (text && mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send('speech:result', text);
      }
    }
  });

  ps.stderr.on('data', (chunk) => {
    const msg = chunk.trim();
    if (!msg) return;
    if (msg === 'READY') {
      // Engine is fully initialised and listening
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('speech:ready');
    } else {
      // Surface actual PowerShell error text to the renderer
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('speech:error', msg);
    }
  });

  ps.on('exit', (code) => {
    const wasKilled = speechKilled;
    speechProcess = null;
    speechKilled  = false;
    // Only report unexpected exits (not intentional kills via stopNativeSpeech)
    if (!wasKilled && code !== 0 && mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('speech:error', 'Speech engine exited (code ' + code + ')');
    }
  });
}

function stopNativeSpeech() {
  if (speechProcess) {
    speechKilled = true;
    speechProcess.kill();
    speechProcess = null;
  }
}

// Registered at module level — safe because ipcMain is global
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

  session.defaultSession.setPermissionRequestHandler((webContents, permission, cb) => {
    cb(permission === 'media' || permission === 'microphone');
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'media' || permission === 'microphone';
  });

  mainWin.loadURL(`http://127.0.0.1:${port}`);
  mainWin.once('ready-to-show', () => mainWin.show());

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
