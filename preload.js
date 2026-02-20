const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe IPC bridge for the native speech recognition path.
// The renderer uses window.electronAPI to communicate with the main process.
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  startSpeech: () => ipcRenderer.invoke('speech:start'),
  stopSpeech:  () => ipcRenderer.invoke('speech:stop'),

  onSpeechResult: (cb) =>
    ipcRenderer.on('speech:result', (_event, text) => cb(text)),

  onSpeechError: (cb) =>
    ipcRenderer.on('speech:error', (_event, msg) => cb(msg)),

  removeSpeechListeners: () => {
    ipcRenderer.removeAllListeners('speech:result');
    ipcRenderer.removeAllListeners('speech:error');
  },
});
