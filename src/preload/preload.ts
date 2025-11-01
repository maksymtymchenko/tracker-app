import { contextBridge, ipcRenderer, desktopCapturer } from 'electron';

contextBridge.exposeInMainWorld('tracker', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (partial: unknown) => ipcRenderer.invoke('config:update', partial),
  onStatus: (cb: (status: string) => void) => {
    const listener = (_e: unknown, status: string) => cb(status);
    ipcRenderer.on('status:update', listener as any);
    return () => ipcRenderer.removeListener('status:update', listener as any);
  },
  // For manual trigger if needed from renderer (not used by main flow)
  captureScreenOnce: async (): Promise<string> => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    const primary = sources[0];
    if (!primary) return '';
    return primary.thumbnail.toDataURL();
  }
});

declare global {
  interface Window {
    tracker: {
      getConfig: () => Promise<any>;
      updateConfig: (partial: unknown) => Promise<any>;
      onStatus: (cb: (status: string) => void) => () => void;
      captureScreenOnce: () => Promise<string>;
    };
  }
}

// Internal: respond to main's screenshot requests
ipcRenderer.on('screenshot:request', async (_e, _reason: string) => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    const primary = sources[0];
    const dataUrl = primary ? primary.thumbnail.toDataURL() : '';
    ipcRenderer.send('screenshot:result', { dataUrl, reason: _reason, meta: { sources: sources.length } });
  } catch (e) {
    ipcRenderer.send('screenshot:result', { dataUrl: '', reason: _reason, error: (e as Error).message });
  }
});


