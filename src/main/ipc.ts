import { ipcMain } from 'electron';
import os from 'os';
import { updateConfig, ensureConfigFile } from './config';

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
}


