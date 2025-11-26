import { contextBridge, ipcRenderer, desktopCapturer } from 'electron';

contextBridge.exposeInMainWorld('tracker', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (partial: unknown) => ipcRenderer.invoke('config:update', partial),
  getUsername: () => ipcRenderer.invoke('username:get'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  onStatus: (cb: (status: string) => void) => {
    const listener = (_e: unknown, status: string) => cb(status);
    ipcRenderer.on('status:update', listener as any);
    return () => ipcRenderer.removeListener('status:update', listener as any);
  },
  // For manual trigger if needed from renderer (not used by main flow)
  captureScreenOnce: async (): Promise<string> => {
    const sources = await desktopCapturer.getSources({ 
      types: ['screen'], 
      thumbnailSize: { width: 1920, height: 1080 } 
    });
    
    if (!sources || sources.length === 0) return '';
    
    // Find the main screen (same logic as IPC handler)
    let primary = sources[0];
    for (const source of sources) {
      if (source.id.includes('screen:0:0')) {
        primary = source;
        break;
      }
      if (source.thumbnail && primary.thumbnail) {
        const sourceSize = source.thumbnail.getSize().width * source.thumbnail.getSize().height;
        const primarySize = primary.thumbnail.getSize().width * primary.thumbnail.getSize().height;
        if (sourceSize > primarySize) {
          primary = source;
        }
      }
    }
    
    if (!primary) return '';
    return primary.thumbnail.toDataURL();
  }
});

declare global {
  interface Window {
    tracker: {
      getConfig: () => Promise<any>;
      updateConfig: (partial: unknown) => Promise<any>;
      getUsername: () => Promise<string>;
      getVersion: () => Promise<string>;
      onStatus: (cb: (status: string) => void) => () => void;
      captureScreenOnce: () => Promise<string>;
    };
  }
}

// Internal: respond to main's screenshot requests
// Note: This should not be used on macOS - screenshot-desktop should be used instead
ipcRenderer.on('screenshot:request', async (_e, _reason: string) => {
  try {
    const sources = await desktopCapturer.getSources({ 
      types: ['screen'], 
      thumbnailSize: { width: 1920, height: 1080 } 
    });
    
    if (!sources || sources.length === 0) {
      throw new Error('No screen sources available');
    }
    
    // Find the main screen (usually the one with id containing "screen:0:0" or the largest one)
    // On macOS, the main screen is typically the first one, but we'll try to find it by size
    let primary = sources[0];
    for (const source of sources) {
      // Prefer screen with "screen:0:0" in ID (main display)
      if (source.id.includes('screen:0:0')) {
        primary = source;
        break;
      }
      // Or prefer the largest thumbnail (likely main screen)
      if (source.thumbnail && primary.thumbnail) {
        const sourceSize = source.thumbnail.getSize().width * source.thumbnail.getSize().height;
        const primarySize = primary.thumbnail.getSize().width * primary.thumbnail.getSize().height;
        if (sourceSize > primarySize) {
          primary = source;
        }
      }
    }
    
    const dataUrl = primary ? primary.thumbnail.toDataURL() : '';
    if (!dataUrl || !dataUrl.startsWith('data:image')) {
      throw new Error('Failed to generate data URL from screen source');
    }
    
    ipcRenderer.send('screenshot:result', { 
      dataUrl, 
      reason: _reason, 
      meta: { 
        sources: sources.length,
        selectedId: primary.id,
        selectedName: primary.name
      } 
    });
  } catch (e) {
    const errorMsg = (e as Error).message || String(e);
    console.error('[tracker] desktopCapturer failed:', errorMsg);
    ipcRenderer.send('screenshot:result', { 
      dataUrl: '', 
      reason: _reason, 
      error: errorMsg 
    });
  }
});


