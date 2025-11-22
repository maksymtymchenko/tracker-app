import path from "path";
import os from "os";
import fs from "fs";
import { app, BrowserWindow, ipcMain } from "electron";
import { ensureConfigFile, updateConfig } from "./config";
import { registerIpcHandlers } from "./ipc";
import { TrayController } from "./tray";
import { EventBuffer } from "./buffer";
import { ActivityTracker } from "./activityTracker";
import { ClipboardMonitor } from "./clipboardMonitor";
import { Screenshotter } from "./screenshotter";
import { ApiClient } from "./api";
import { BaseEvent } from "../types/events";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger";
import { AutoUpdater } from "./autoUpdater";
import { setAutoUpdaterInstance } from "./ipc";

let mainWindow: BrowserWindow | null = null;
let isTracking = false;
const deviceId = uuidv4();

/**
 * Get current logged-in username (for multi-user remote desktop support).
 * On Windows RDP/macOS, each user session has its own username.
 */
function getCurrentUsername(): string {
  try {
    return (
      os.userInfo().username ||
      process.env.USER ||
      process.env.USERNAME ||
      "unknown"
    );
  } catch {
    return process.env.USER || process.env.USERNAME || "unknown";
  }
}

function getEffectiveServerUrl(serverUrlFromConfig: string): string {
  const DEV_URL = "http://localhost:4000";
  const PROD_URL = "https://tracker-dashboard-zw8l.onrender.com";
  // If user explicitly set a URL, respect it
  if (serverUrlFromConfig && !/localhost/i.test(serverUrlFromConfig))
    return serverUrlFromConfig;
  // Otherwise choose by environment
  return app.isPackaged ? PROD_URL : DEV_URL;
}

function sendStatus(status: string): void {
  if (mainWindow) mainWindow.webContents.send("status:update", status);
}

/**
 * Configure app to start on system boot (Windows/macOS)
 */
function configureStartup(enabled: boolean): void {
  try {
    // On Windows, this adds the app to the startup folder
    // On macOS, this adds it to Login Items
    // Note: In dev mode on macOS, this may fail due to missing app signing
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true, // Start minimized to tray
    });
    console.log(`[tracker] Startup ${enabled ? "enabled" : "disabled"}`);
  } catch (err) {
    // In dev mode, this is expected to fail on macOS
    if (app.isPackaged) {
      console.error(
        `[tracker] Failed to ${enabled ? "enable" : "disable"} startup:`,
        (err as Error).message
      );
    } else {
      console.log(
        `[tracker] Startup setting skipped in dev mode: ${(err as Error).message}`
      );
    }
  }
}

/**
 * Check if app is currently set to start on boot
 */
function isStartupEnabled(): boolean {
  try {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin || false;
  } catch {
    return false;
  }
}

async function createWindow(): Promise<void> {
  // Prevent creating multiple windows
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const config = ensureConfigFile();
  // Ensure IPC is ready before renderer requests
  registerIpcHandlers();
  mainWindow = new BrowserWindow({
    width: 520,
    height: 380,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const isDev = !app.isPackaged;
  if (isDev) {
    await mainWindow.loadFile(
      path.join(process.cwd(), "dist/renderer/index.html")
    );
  } else {
    // In production, try multiple possible paths (Windows may package differently)
    const possiblePaths = [
      path.join(__dirname, "../renderer/index.html"),
      path.join(app.getAppPath(), "dist", "renderer", "index.html"),
      path.join(app.getAppPath(), "renderer", "index.html"),
    ];

    let loaded = false;
    for (const htmlPath of possiblePaths) {
      try {
        if (fs.existsSync(htmlPath)) {
          console.log("[tracker] loading HTML from:", htmlPath);
          await mainWindow.loadFile(htmlPath);
          loaded = true;
          break;
        }
      } catch (err) {
        console.log("[tracker] failed to load from:", htmlPath, err);
      }
    }

    if (!loaded) {
      console.error("[tracker] HTML file not found, trying loadURL fallback");
      // Last resort: try direct URL
      const fallbackPath = path.join(
        app.getAppPath(),
        "dist",
        "renderer",
        "index.html"
      );
      const url = `file://${fallbackPath}`.replace(/\\/g, "/");
      if (mainWindow) {
        mainWindow.loadURL(url);
      }
    }
  }

  mainWindow.on("close", (e) => {
    // Prevent window from closing (hide instead) unless we're actually quitting
    // This allows the app to run in the background on all platforms
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    } else {
      // When actually quitting, allow window to close
      mainWindow = null;
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Open DevTools on Windows if there's an issue (helpful for debugging white screen)
  mainWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription) => {
      console.error(
        "[tracker] failed to load page:",
        errorCode,
        errorDescription
      );
      if (mainWindow && !isDev) {
        mainWindow.webContents.openDevTools();
      }
    }
  );

  mainWindow.webContents.on("console-message", (event, level, message) => {
    console.log(`[renderer:${level}]`, message);
  });

  // IPC already registered above

  // Create tray only once
  if (!trayController) {
    trayController = new TrayController({
      onStart: () => startTracking(),
      onStop: () => stopTracking(),
      onQuit: () => {
        isQuitting = true;
        stopTracking();
        // Properly destroy window before quitting
        if (mainWindow) {
          mainWindow.removeAllListeners("close");
          mainWindow.destroy();
          mainWindow = null;
        }
        app.quit();
      },
      onShow: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          // Recreate window if it doesn't exist
          createWindow().catch((err) => {
            console.error("[tracker] failed to recreate window:", err);
          });
        }
      },
      onHide: () => mainWindow?.hide(),
      onCapture: () => {
        logger.log("[tracker] Manual screenshot requested from tray menu");
        logger.log(`[tracker] Log file location: ${logger.getLogPath()}`);
        if (screenshotter) {
          screenshotter.capture("manual").catch((err) => {
            logger.error(
              "[tracker] Manual screenshot capture failed:",
              (err as Error).message
            );
            if ((err as Error).stack) {
              logger.error(
                "[tracker] Manual screenshot error stack:",
                (err as Error).stack
              );
            }
          });
        } else {
          logger.error(
            "[tracker] ERROR: screenshotter is null! Screenshots may not be enabled in config."
          );
        }
      },
      onToggleStartup: () => {
        if (process.platform === "win32" || process.platform === "darwin") {
          const current = isStartupEnabled();
          const newValue = !current;
          configureStartup(newValue);
          // Update config
          const config = ensureConfigFile();
          updateConfig({ ...config, startOnBoot: newValue });
          // Refresh tray menu
          if (trayController && mainWindow) {
            trayController.updateMenu(mainWindow);
          }
        }
      },
      onCheckForUpdates: () => {
        if (autoUpdater) {
          autoUpdater.checkForUpdates().catch((err) => {
            logger.error('[updater] Manual check failed:', (err as Error).message);
          });
        }
      },
      isStartupEnabled: () => {
        if (process.platform === "win32" || process.platform === "darwin") {
          return isStartupEnabled();
        }
        return false;
      },
    });
  }
  trayController.init(mainWindow);

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
let trayController: TrayController | null = null;
let autoUpdater: AutoUpdater | null = null;

function setupTracking(username: string): void {
  const config = ensureConfigFile();
  buffer = new EventBuffer(config.batchSize);
  const serverUrl = getEffectiveServerUrl(config.serverUrl);
  apiClient = new ApiClient(serverUrl);
  if (!serverUrl) {
    sendStatus("Warning: Server URL not configured");
  }

  const onEvent = (e: BaseEvent): void => {
    try {
      // Override username with current logged-in user (for multi-user remote desktop)
      e.username = getCurrentUsername();
      // Developer log: event queued
      const appName = (e.data as any)?.application || "N/A";
      console.log(
        `[tracker] queued event: type=${e.type} user=${e.username} app=${appName} ts=${e.timestamp}`
      );
    } catch (err) {
      console.error(
        "[tracker] Error processing event:",
        (err as Error).message
      );
      // Continue with event even if username setting fails
    }

    try {
      buffer.add(e);
      const pending = buffer.size();
      // Always show status when events are queued
      if (pending > 0) {
        sendStatus(`Tracking active (${pending} pending)`);
      }
      // Check if we should flush immediately
      if (pending >= config.batchSize) {
        flushNow().catch((err) => {
          console.error("[tracker] Error in flushNow:", (err as Error).message);
        });
      }
    } catch (err) {
      console.error(
        "[tracker] Error adding event to buffer:",
        (err as Error).message
      );
      // Don't crash - just log the error
    }
  };

  // Create screenshotter FIRST so it's available when activity tracker callback fires
  if (config.trackScreenshots) {
    screenshotter = new Screenshotter(
      {
        username,
        deviceId,
        domain: "windows-desktop",
        minIntervalMs: config.minScreenshotInterval,
        requestCapture: (reason: string) =>
          new Promise<string>((resolve) => {
            if (!mainWindow) {
              console.log(
                "[tracker] screenshot fallback: mainWindow is null, cannot use renderer fallback"
              );
              return resolve("");
            }

            let timeout: NodeJS.Timeout;
            const once = (
              _e: any,
              payload: {
                dataUrl: string;
                reason: string;
                meta?: any;
                error?: string;
              }
            ) => {
              clearTimeout(timeout);
              try {
                console.log("[tracker] screenshot: result", {
                  len: payload?.dataUrl?.length || 0,
                  reason: payload?.reason,
                  meta: payload?.meta,
                  error: payload?.error,
                });
                if (payload?.error) {
                  console.log(
                    `[tracker] screenshot: renderer error: ${payload.error}`
                  );
                }
              } catch {}
              resolve(payload?.dataUrl || "");
              ipcMain.removeListener("screenshot:result", once as any);
            };

            timeout = setTimeout(() => {
              console.log(
                "[tracker] screenshot fallback: timeout waiting for renderer response"
              );
              ipcMain.removeListener("screenshot:result", once as any);
              resolve("");
            }, 10000); // 10 second timeout

            console.log("[tracker] screenshot: ipc request -> renderer");
            ipcMain.on("screenshot:result", once as any);
            mainWindow.webContents.send("screenshot:request", reason);
          }),
      },
      (event, base64) => {
        onEvent(event);
        // fire-and-forget upload, coalesced by server
        const currentUser = getCurrentUsername();
        const base64Length = base64 ? base64.length : 0;
        console.log(
          `[tracker] Uploading screenshot: ${base64Length} bytes, user: ${currentUser}, reason: ${
            (event.data as any)?.reason || "unknown"
          }`
        );
        apiClient
          .uploadScreenshot({
            deviceId,
            domain: "windows-desktop",
            username: currentUser,
            screenshot: base64,
          })
          .then(() => {
            try {
              console.log(
                `[tracker] screenshot upload: SUCCESS (user: ${currentUser}, size: ${base64Length} bytes)`
              );
            } catch {}
          })
          .catch((err) => {
            try {
              const errorMsg = err?.message || err || "Unknown error";
              const statusCode = err?.response?.status;
              const statusText = err?.response?.statusText;
              console.log(
                `[tracker] screenshot upload: FAILED (user: ${currentUser}, size: ${base64Length} bytes)`
              );
              console.log(
                `[tracker] screenshot upload error: ${errorMsg}${
                  statusCode ? ` (HTTP ${statusCode} ${statusText})` : ""
                }`
              );
              if (err?.response?.data) {
                console.log(
                  `[tracker] screenshot upload error response:`,
                  err.response.data
                );
              }
            } catch {}
          });
      }
    );
  }

  // Create activity tracker AFTER screenshotter so it can reference it
  activity = new ActivityTracker(
    {
      username,
      deviceId,
      domain: "windows-desktop",
      intervalMs: config.trackingInterval,
      minActivityDuration: config.minActivityDuration,
      maxIdleTime: config.maxIdleTime,
    },
    (e) => {
      onEvent(e);
      if (config.trackScreenshots && config.screenshotOnWindowChange) {
        console.log("[tracker] screenshot: request on window_change");
        if (screenshotter) {
          screenshotter.capture("window_change").catch((err) => {
            console.error(
              "[tracker] screenshot capture error:",
              (err as Error).message
            );
          });
        } else {
          console.log(
            "[tracker] WARNING: screenshotter is null when window change detected!"
          );
        }
      }
    }
  );

  if (config.trackClipboard) {
    clipboardMon = new ClipboardMonitor(
      {
        username,
        deviceId,
        domain: "windows-desktop",
        pollIntervalMs: 1500,
        maxLength: 1000,
      },
      onEvent
    );
  }

  // Optional: global click-to-screenshot
  if (config.trackScreenshots && config.screenshotOnClick) {
    try {
      // Lazy import to avoid native init on platforms where not desired
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ioHook = require("iohook");
      ioHook.on("mousedown", () => {
        screenshotter?.capture("click").catch(() => {});
      });
      ioHook.start();
      console.log("[tracker] iohook: click listener started");
    } catch (e) {
      // iohook is optional and may not be available in dev mode
      // Only log once, not on every require attempt
      if (!app.isPackaged) {
        console.log("[tracker] iohook not available (optional dependency):", (e as Error).message);
      } else {
        console.log("[tracker] iohook not available:", (e as Error).message);
      }
    }
  }

  if (flushTimer) clearInterval(flushTimer);
  // Flush every 5 seconds to ensure events are sent promptly
  flushTimer = setInterval(() => flushNow().catch(() => {}), 5000);
}

async function flushNow(): Promise<void> {
  const events = buffer.drain();
  if (events.length === 0) {
    // Still show status even if no events to flush
    const pending = buffer.size();
    if (pending > 0) {
      sendStatus(`Tracking active (${pending} pending)`);
    }
    return;
  }
  const config = ensureConfigFile();
  apiClient = new ApiClient(getEffectiveServerUrl(config.serverUrl));
  try {
    console.log(
      `[tracker] flushing ${events.length} event(s) to ${
        config.serverUrl || "(no server)"
      }`
    );
    await apiClient.sendActivityBatch(events);
    console.log(`[tracker] flush success: ${events.length} event(s)`);
    const pending = buffer.size();
    if (pending > 0) {
      sendStatus(`Tracking active (${pending} pending)`);
    } else {
      sendStatus("Tracking active");
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    sendStatus(`Network error: ${errorMsg}`);
    console.log("[tracker] flush failed:", errorMsg);
    // On error, re-queue at head by simply pushing back (simple approach)
    events.forEach((e) => buffer.add(e));
    const pending = buffer.size();
    if (pending > 0) {
      sendStatus(`Tracking active (${pending} pending) - retrying`);
    }
  }
}

function startTracking(): void {
  if (isTracking) return;
  const config = ensureConfigFile();
  setupTracking(config.username);
  activity.start();
  clipboardMon?.start();
  isTracking = true;
  sendStatus("Tracking started");
  console.log("[tracker] tracking started");
}

function stopTracking(): void {
  if (!isTracking) return;
  activity.stop();
  clipboardMon?.stop();
  if (ioHook) {
    try {
      ioHook.removeAllListeners("mousedown");
      ioHook.stop();
      console.log("[tracker] iohook: stopped");
    } catch {}
    ioHook = null;
  }
  isTracking = false;
  sendStatus("Tracking stopped");
  console.log("[tracker] tracking stopped");
}

// Track if app is quitting to prevent window recreation
let isQuitting = false;

app.whenReady().then(() => {
  // Configure startup on Windows/macOS based on config
  const config = ensureConfigFile();
  logger.log(`App starting - Log file: ${logger.getLogPath()}`);
  logger.log(`Platform: ${process.platform}, Packaged: ${app.isPackaged}`);
  if (process.platform === "win32" || process.platform === "darwin") {
    configureStartup(config.startOnBoot);
  }
  
  // Initialize and start auto-updater
  try {
    autoUpdater = new AutoUpdater();
    setAutoUpdaterInstance(autoUpdater);
    autoUpdater.start();
    logger.log('[updater] Auto-updater initialized');
  } catch (err) {
    logger.error('[updater] Failed to initialize auto-updater:', (err as Error).message);
  }
  
  createWindow();
});

app.on("window-all-closed", () => {
  // Keep app alive even when all windows are closed
  // The app runs in the background via system tray on all platforms
  // Only quit when user explicitly clicks "Quit" from tray menu
});

// macOS: Recreate window when app is activated and no window exists
app.on("activate", () => {
  // Reset quit flag on reactivation
  isQuitting = false;
  if (mainWindow === null) {
    createWindow().catch((err) => {
      console.error("[tracker] failed to recreate window:", err);
    });
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on("before-quit", async (e) => {
  isQuitting = true;
  // Prevent default quit behavior to allow cleanup
  await flushNow().catch(() => {});
  // Destroy window properly
  if (mainWindow) {
    mainWindow.removeAllListeners("close");
    mainWindow.close();
  }
});
