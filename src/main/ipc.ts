import { ipcMain } from 'electron';
import { updateConfig, ensureConfigFile } from './config';

export function registerIpcHandlers(): void {
  ipcMain.handle('config:get', () => ensureConfigFile());
  ipcMain.handle('config:update', (_e, partial) => updateConfig(partial));
}


