const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studybuddy', {
  isNative: true,
  ollamaFetch: (path, options) => ipcRenderer.invoke('ollama:fetch', path, options),
  installLocalAI: () => ipcRenderer.invoke('local-ai:install'),
  localAIStatus: () => ipcRenderer.invoke('local-ai:status'),
  exportNotesPdf: (payload) => ipcRenderer.invoke('notes:export-pdf', payload),
  speechAvailable: true,
  startSpeech: (locale) => ipcRenderer.invoke('speech:start', locale),
  stopSpeech: () => ipcRenderer.invoke('speech:stop'),
  onSpeechEvent: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('speech:event', listener);
    return () => ipcRenderer.removeListener('speech:event', listener);
  },
  onAppCommand: (callback) => {
    const listener = (_, command) => callback(command);
    ipcRenderer.on('app:command', listener);
    return () => ipcRenderer.removeListener('app:command', listener);
  }
});
