import path from 'path';
import os from 'os';
import { app, BrowserWindow, ipcMain } from 'electron';
import { ensureConfigFile } from './config';
import { registerIpcHandlers } from './ipc';
import { TrayController } from './tray';
import { EventBuffer } from './buffer';
import { ActivityTracker } from './activityTracker';
import { ClipboardMonitor } from './clipboardMonitor';
import { Screenshotter } from './screenshotter';
import { ApiClient } from './api';
import { BaseEvent } from '../types/events';
import { v4 as uuidv4 } from 'uuid';

let mainWindow: BrowserWindow | null = null;
let isTracking = false;
const deviceId = uuidv4();

/**
 * Get current logged-in username (for multi-user remote desktop support).
 * On Windows RDP/macOS, each user session has its own username.
 */
function getCurrentUsername(): string {
  try {
    return os.userInfo().username || process.env.USER || process.env.USERNAME || 'unknown';
  } catch {
    return process.env.USER || process.env.USERNAME || 'unknown';
  }
}

function sendStatus(status: string): void {
  if (mainWindow) mainWindow.webContents.send('status:update', status);
}

async function createWindow(): Promise<void> {
  const config = ensureConfigFile();
  // Ensure IPC is ready before renderer requests
  registerIpcHandlers();
  mainWindow = new BrowserWindow({
    width: 520,
    height: 380,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const isDev = !app.isPackaged;
  if (isDev) {
    await mainWindow.loadFile(path.join(process.cwd(), 'src/renderer/index.html'));
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow?.hide();
  });

  // IPC already registered above

  const tray = new TrayController({
    onStart: () => startTracking(),
    onStop: () => stopTracking(),
    onQuit: () => {
      stopTracking();
      app.quit();
    },
    onShow: () => mainWindow?.show(),
    onHide: () => mainWindow?.hide(),
    onCapture: () => screenshotter?.capture('manual').catch(() => {})
  });
  tray.init(mainWindow);

  // Initialize trackers but start/stop controlled via tray
  setupTracking(config.username);
  // Auto-start tracking to collect events immediately
  startTracking();
}

let buffer: EventBuffer;
let activity: ActivityTracker;
let clipboardMon: ClipboardMonitor | null = null;
let screenshotter: Screenshotter | null = null;
let apiClient: ApiClient;
let flushTimer: NodeJS.Timeout | null = null;
let ioHook: any | null = null;

function setupTracking(username: string): void {
  const config = ensureConfigFile();
  buffer = new EventBuffer(config.batchSize);
  apiClient = new ApiClient(config.serverUrl);

  const onEvent = (e: BaseEvent): void => {
    try {
      // Override username with current logged-in user (for multi-user remote desktop)
      e.username = getCurrentUsername();
      // Developer log: event queued
      console.log(`[tracker] queued event: type=${e.type} user=${e.username} ts=${e.timestamp}`);
    } catch {}
    const shouldFlush = buffer.add(e);
    if (shouldFlush) flushNow().catch(() => {});
  };

  activity = new ActivityTracker(
    {
      username,
      deviceId,
      domain: 'windows-desktop',
      intervalMs: config.trackingInterval,
      minActivityDuration: config.minActivityDuration,
      maxIdleTime: config.maxIdleTime
    },
    (e) => {
      onEvent(e);
      if (config.trackScreenshots && config.screenshotOnWindowChange) {
        console.log('[tracker] screenshot: request on window_change');
        screenshotter?.capture('window_change').catch(() => {});
      }
    }
  );

  if (config.trackClipboard) {
    clipboardMon = new ClipboardMonitor(
      { username, deviceId, domain: 'windows-desktop', pollIntervalMs: 1500, maxLength: 1000 },
      onEvent
    );
  }

  if (config.trackScreenshots) {
    screenshotter = new Screenshotter(
      {
        username,
        deviceId,
        domain: 'windows-desktop',
        minIntervalMs: config.minScreenshotInterval,
        requestCapture: (reason: string) =>
          new Promise<string>((resolve) => {
            if (!mainWindow) return resolve('');
            const once = (_e: any, payload: { dataUrl: string; reason: string; meta?: any; error?: string }) => {
              try {
                console.log('[tracker] screenshot: result', { len: payload?.dataUrl?.length || 0, reason: payload?.reason, meta: payload?.meta, error: payload?.error });
              } catch {}
              resolve(payload?.dataUrl || '');
              ipcMain.removeListener('screenshot:result', once as any);
            };
            console.log('[tracker] screenshot: ipc request -> renderer');
            ipcMain.on('screenshot:result', once as any);
            mainWindow.webContents.send('screenshot:request', reason);
          })
      },
      (event, base64) => {
        onEvent(event);
        // fire-and-forget upload, coalesced by server
        const currentUser = getCurrentUsername();
        apiClient
          .uploadScreenshot({ deviceId, domain: 'windows-desktop', username: currentUser, screenshot: base64 })
          .then(() => {
            try {
              console.log(`[tracker] screenshot upload: success (user: ${currentUser})`);
            } catch {}
          })
          .catch((err) => {
            try {
              console.log(`[tracker] screenshot upload: failed (user: ${currentUser})`, err?.message || err);
            } catch {}
          });
      }
    );
  }

  // Optional: global click-to-screenshot
  if (config.trackScreenshots && config.screenshotOnClick) {
    try {
      // Lazy import to avoid native init on platforms where not desired
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ioHook = require('iohook');
      ioHook.on('mousedown', () => {
        screenshotter?.capture('click').catch(() => {});
      });
      ioHook.start();
      console.log('[tracker] iohook: click listener started');
    } catch (e) {
      console.log('[tracker] iohook not available:', (e as Error).message);
    }
  }

  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => flushNow().catch(() => {}), Math.max(config.trackingInterval, 5000));
}

async function flushNow(): Promise<void> {
  const events = buffer.drain();
  if (events.length === 0) return;
  const config = ensureConfigFile();
  apiClient = new ApiClient(config.serverUrl);
  try {
    console.log(`[tracker] flushing ${events.length} event(s) to ${config.serverUrl || '(no server)'}`);
    await apiClient.sendActivityBatch(events);
    sendStatus(`Sent ${events.length} event(s)`);
    console.log(`[tracker] flush success: ${events.length} event(s)`);
  } catch {
    sendStatus('Network error: will retry on next cycle');
    console.log('[tracker] flush failed: will retry on next cycle');
    // On error, re-queue at head by simply pushing back (simple approach)
    events.forEach((e) => buffer.add(e));
  }
}

function startTracking(): void {
  if (isTracking) return;
  const config = ensureConfigFile();
  setupTracking(config.username);
  activity.start();
  clipboardMon?.start();
  isTracking = true;
  sendStatus('Tracking started');
  console.log('[tracker] tracking started');
}

function stopTracking(): void {
  if (!isTracking) return;
  activity.stop();
  clipboardMon?.stop();
  if (ioHook) {
    try {
      ioHook.removeAllListeners('mousedown');
      ioHook.stop();
      console.log('[tracker] iohook: stopped');
    } catch {}
    ioHook = null;
  }
  isTracking = false;
  sendStatus('Tracking stopped');
  console.log('[tracker] tracking stopped');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // keep app alive in tray (do nothing here)
});

app.on('before-quit', async () => {
  await flushNow().catch(() => {});
});


