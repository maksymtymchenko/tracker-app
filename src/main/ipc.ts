import { ipcMain, app } from 'electron';
import os from 'os';
import { updateConfig, ensureConfigFile } from './config';

let autoUpdaterInstance: any = null;

export function setAutoUpdaterInstance(instance: any): void {
  autoUpdaterInstance = instance;
}

function getCurrentUsername(): string {
  try {
    return os.userInfo().username || process.env.USER || process.env.USERNAME || 'unknown';
  } catch {
    return process.env.USER || process.env.USERNAME || 'unknown';
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle('config:get', () => ensureConfigFile());
  ipcMain.handle('config:update', (_e, partial) => updateConfig(partial));
  ipcMain.handle('username:get', () => getCurrentUsername());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('updater:check', async () => {
    if (autoUpdaterInstance) {
      await autoUpdaterInstance.checkForUpdates();
      return { success: true };
    }
    return { success: false, error: 'Auto-updater not initialized' };
  });
  // Password dialog IPC
  ipcMain.on('password:result', (event, password: string) => {
    event.returnValue = undefined;
  });
}

/**
 * Remove all IPC handlers to prevent file locks during update
 */
export function removeAllIpcHandlers(): void {
  try {
    ipcMain.removeHandler('config:get');
    ipcMain.removeHandler('config:update');
    ipcMain.removeHandler('username:get');
    ipcMain.removeHandler('app:version');
    ipcMain.removeHandler('updater:check');
    // Remove any screenshot listeners
    ipcMain.removeAllListeners('screenshot:result');
    ipcMain.removeAllListeners('screenshot:request');
  } catch (err) {
    // Ignore errors during cleanup
  }
}


