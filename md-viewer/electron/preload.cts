import { contextBridge, ipcRenderer, webUtils } from 'electron';
contextBridge.exposeInMainWorld('viewer', {
  initial: () => ipcRenderer.invoke('initial'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  dropFiles: (files: File[]) => ipcRenderer.invoke('drop-files', files.map(f => webUtils.getPathForFile(f)).filter(Boolean)),
  closeDocument: (id: string) => ipcRenderer.invoke('close-document', id),
  draft: (id: string, draft: unknown) => ipcRenderer.invoke('draft', id, draft),
  saveDocument: (id: string, draft: unknown) => ipcRenderer.invoke('save-document', id, draft),
  reloadDocument: (id: string) => ipcRenderer.invoke('reload-document', id),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('save-settings', settings),
  link: (id: string, href: string) => ipcRenderer.invoke('link', id, href),
  onOpen: (cb: (doc: unknown) => void) => { const fn = (_e: unknown, doc: unknown) => cb(doc); ipcRenderer.on('document-open', fn); return () => ipcRenderer.removeListener('document-open', fn); },
  onUpdate: (cb: (doc: unknown) => void) => { const fn = (_e: unknown, doc: unknown) => cb(doc); ipcRenderer.on('document-update', fn); return () => ipcRenderer.removeListener('document-update', fn); },
  onSaved: (cb: (doc: unknown) => void) => { const fn = (_e: unknown, doc: unknown) => cb(doc); ipcRenderer.on('document-saved', fn); return () => ipcRenderer.removeListener('document-saved', fn); },
  onSaveError: (cb: (message: string) => void) => { ipcRenderer.on('save-error', (_e, message) => cb(message)); }
});
