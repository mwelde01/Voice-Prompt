const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  startSpeech: () => ipcRenderer.invoke('speech:start'),
  stopSpeech:  () => ipcRenderer.invoke('speech:stop'),

  // Called once when PowerShell confirms the engine is ready
  onSpeechReady:  (cb) => ipcRenderer.on('speech:ready',  ()           => cb()),
  // Called for every recognised phrase
  onSpeechResult: (cb) => ipcRenderer.on('speech:result', (_e, text)   => cb(text)),
  // Called when an error message arrives from PowerShell stderr
  onSpeechError:  (cb) => ipcRenderer.on('speech:error',  (_e, msg)    => cb(msg)),

  // Must be called before re-attaching listeners (e.g. on restart)
  removeSpeechListeners: () => {
    ipcRenderer.removeAllListeners('speech:ready');
    ipcRenderer.removeAllListeners('speech:result');
    ipcRenderer.removeAllListeners('speech:error');
  },
});
