import { autoUpdater as electronAutoUpdater } from "electron-updater";
import { app, dialog } from "electron";
import path from "path";
import os from "os";
import fs from "fs";
import { logger } from "./logger";
import { WindowsProcessManager } from "./windowsProcessManager";

/**
 * Auto-updater configuration for Cloudflare R2 bucket
 * Uses S3-compatible API
 */
export class AutoUpdater {
  private updateCheckInterval: NodeJS.Timeout | null = null;
  private readonly checkIntervalMs = 60 * 60 * 1000; // Check every hour
  private readonly prepareForUpdate: (() => Promise<void>) | null;
  private updateDownloaded = false;
  private cacheDir: string;
  private processManager: WindowsProcessManager | null = null;

  constructor(prepareForUpdate?: () => Promise<void>) {
    this.prepareForUpdate = prepareForUpdate || null;
    // Configure auto-updater
    electronAutoUpdater.autoDownload = false; // Don't auto-download, let user choose
    electronAutoUpdater.autoInstallOnAppQuit = true; // Install on quit after download

    // Initialize Windows process manager for multi-user session support
    if (process.platform === "win32") {
      try {
        this.processManager = new WindowsProcessManager();
        logger.log("[updater] Windows process manager initialized");
      } catch (err) {
        logger.error(`[updater] Failed to initialize process manager: ${(err as Error).message}`);
      }
    }

    // Set cache directory to user-writable location to avoid permission issues
    // On Windows, use AppData to ensure write permissions
    this.cacheDir = process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "windows-activity-tracker-updates")
      : path.join(os.homedir(), ".windows-activity-tracker-updates");
    
    // Ensure cache directory exists
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      // Note: electron-updater doesn't expose cacheDir as a property in TypeScript
      // but it will use the directory we create for caching updates
      logger.log(`[updater] Cache directory set to: ${this.cacheDir}`);
    } catch (err) {
      logger.error(`[updater] Failed to set cache directory: ${(err as Error).message}`);
      // Continue anyway - electron-updater will use default location
      this.cacheDir = "default";
    }

    // Set update server URL (Cloudflare R2 bucket)
    // For Cloudflare R2 public bucket, use: https://<bucket-name>.r2.dev
    // Or custom domain: https://<your-domain.com>
    // The bucket should contain latest.yml (or latest-mac.yml, latest-win.yml) files
    // Include subdirectory path if files are in a subdirectory
    const updateServerUrl =
      process.env.UPDATE_SERVER_URL ||
      "https://pub-783c37b34b55408d998282fd1a2781f6.r2.dev/tracker-app-auto-update";

    electronAutoUpdater.setFeedURL({
      provider: "generic",
      url: updateServerUrl,
    });

    logger.log(`[updater] Update server URL: ${updateServerUrl}`);
    logger.log(`[updater] App version at startup: ${app.getVersion()}`);

    // Setup event handlers
    this.setupEventHandlers();
  }

  /**
   * Setup auto-updater event handlers
   */
  private setupEventHandlers(): void {
    electronAutoUpdater.on("checking-for-update", () => {
      logger.log(`[updater] Checking for updates... Current version: ${app.getVersion()}`);
    });

    electronAutoUpdater.on("update-available", (info) => {
      const currentVersion = app.getVersion();
      logger.log(`[updater] Update available: ${info.version} (current: ${currentVersion})`);
      
      // Safety check: don't update to the same version
      if (info.version === currentVersion) {
        logger.log(`[updater] Already on version ${info.version}, skipping update`);
        return;
      }
      
      this.showUpdateAvailableDialog(info);
    });

    electronAutoUpdater.on("update-not-available", (info) => {
      logger.log(
        `[updater] Update not available. App version: ${app.getVersion()}, Latest available: ${info.version}`
      );
      // Optionally show a message for manual checks
      // For automatic checks, we stay silent
    });

    electronAutoUpdater.on("error", (err) => {
      // Check if it's a 404 error (update file not found)
      const errorMessage = err.message || "";
      const is404Error =
        errorMessage.includes("404") ||
        errorMessage.includes("Not Found") ||
        errorMessage.includes("Cannot find channel");
      
      // Check if it's a permission error
      const isPermissionError =
        errorMessage.includes("EPERM") ||
        errorMessage.includes("operation not permitted") ||
        errorMessage.includes("permission denied") ||
        errorMessage.includes("EACCES");

      if (is404Error) {
        // 404 means no update file exists yet - this is normal for first release
        // or when update server hasn't been set up yet
        logger.log(
          "[updater] No update information available (update server not configured or first release)"
        );
      } else if (isPermissionError) {
        // Permission error - log with helpful message
        logger.error(
          `[updater] Permission error: ${errorMessage}. Cache directory: ${this.cacheDir || "default"}`
        );
        // Show user-friendly error message
        if (app.isReady()) {
          try {
            dialog.showErrorBox(
              "Update Download Failed",
              "Failed to download update due to permission issues. Please ensure the app has write permissions to your user directory, or try running the app as administrator."
            );
          } catch (err) {
            // Ignore dialog errors
          }
        }
      } else {
        // For other errors, log them but don't alarm the user
        logger.log(`[updater] Update check failed: ${errorMessage}`);
      }
      // Don't show error dialog for network errors (user might be offline)
      // Only log to console
    });

    electronAutoUpdater.on("download-progress", (progressObj) => {
      const message = `Downloaded ${progressObj.percent}% (${progressObj.transferred}/${progressObj.total})`;
      logger.log(`[updater] ${message}`);
    });

    electronAutoUpdater.on("update-downloaded", (info) => {
      logger.log(`[updater] Update downloaded: ${info.version}`);
      this.updateDownloaded = true;
      this.showUpdateDownloadedDialog(info);
    });
  }

  /**
   * Show dialog when update is available
   */
  private showUpdateAvailableDialog(info: {
    version: string;
    releaseDate: string;
  }): void {
    if (!app.isReady()) return;

    dialog
      .showMessageBox({
        type: "info",
        title: "Update Available",
        message: `A new version (${info.version}) is available.`,
        detail: "Would you like to download it now?",
        buttons: ["Download Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) {
          this.downloadUpdate();
        }
      })
      .catch((err) => {
        logger.error(
          "[updater] Error showing update dialog:",
          (err as Error).message
        );
      });
  }

  /**
   * Check for processes running in other user sessions and handle them
   * Returns true if it's safe to proceed with update, false otherwise
   */
  private async checkAndTerminateOtherSessions(): Promise<boolean> {
    if (process.platform !== "win32" || !this.processManager) {
      return true; // Not Windows or process manager not available
    }

    try {
      const processes = await this.processManager.detectAllProcesses();
      
      if (processes.length === 0) {
        logger.log("[updater] No processes found across all sessions");
        return true;
      }

      // Check if there are processes from other users (which indicates other sessions)
      const currentUsername = (process.env.USERNAME || process.env.USER || '').toLowerCase();
      const otherUserProcesses = processes.filter(p => 
        p.username.toLowerCase() !== currentUsername
      );
      
      // If all processes are from current user, we can proceed (they'll be terminated by prepareForUpdate)
      if (otherUserProcesses.length === 0) {
        logger.log("[updater] All processes are from current user session");
        return true;
      }

      // Found processes in other sessions - show dialog
      const statusMessage = await this.processManager.getProcessStatusMessage();
      
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "Update Requires Closing Application",
        message: "The application is running in other user sessions.",
        detail: `${statusMessage}\n\nWould you like to attempt to close all instances? Administrator privileges may be required.`,
        buttons: ["Close All Instances", "Cancel Update"],
        defaultId: 0,
        cancelId: 1,
      });

      if (result.response !== 0) {
        logger.log("[updater] User cancelled update due to processes in other sessions");
        return false;
      }

      // Attempt to terminate all processes
      logger.log("[updater] Attempting to terminate processes across all sessions");
      const terminationResult = await this.processManager.terminateAllProcesses(true);

      if (terminationResult.success) {
        logger.log(`[updater] Successfully terminated ${terminationResult.processesTerminated} process(es)`);
        await dialog.showMessageBox({
          type: "info",
          title: "Processes Closed",
          message: `Successfully closed ${terminationResult.processesTerminated} instance(s) of the application.`,
          detail: "The update can now proceed.",
          buttons: ["OK"],
        });
        return true;
      } else {
        // Some processes couldn't be terminated
        const errorDetails = terminationResult.errors.length > 0
          ? `\n\nErrors:\n${terminationResult.errors.slice(0, 3).join('\n')}`
          : '';
        
        let message = `Could not close all instances of the application.\n\n`;
        message += `Closed: ${terminationResult.processesTerminated} of ${terminationResult.processesFound}\n`;
        message += `Remaining: ${terminationResult.processesFound - terminationResult.processesTerminated}`;
        
        if (terminationResult.requiresAdmin) {
          message += `\n\nAdministrator privileges are required to close processes in other user sessions.`;
          message += `\n\nPlease either:\n`;
          message += `1. Run this application as Administrator and try again, or\n`;
          message += `2. Sign out all other user sessions, or\n`;
          message += `3. Manually close the application in other sessions using Task Manager.`;
        }

        const userChoice = await dialog.showMessageBox({
          type: "error",
          title: "Cannot Close All Instances",
          message: message,
          detail: errorDetails,
          buttons: ["Retry", "Cancel Update"],
          defaultId: 0,
          cancelId: 1,
        });

        if (userChoice.response === 0) {
          // Retry
          return await this.checkAndTerminateOtherSessions();
        }

        return false;
      }
    } catch (err) {
      logger.error("[updater] Error checking processes:", (err as Error).message);
      // On error, show warning but allow update to proceed
      // The installer will handle process termination
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "Update Warning",
        message: "Could not verify if the application is running in other user sessions.",
        detail: "The update will proceed, but may fail if the application is running in another user's session.\n\nIf the update fails, please close all instances of the application manually.",
        buttons: ["Continue Anyway", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });
      return result.response === 0;
    }
  }

  /**
   * Show dialog when update is downloaded and ready to install
   */
  private showUpdateDownloadedDialog(info: { version: string }): void {
    if (!app.isReady()) return;

    dialog
      .showMessageBox({
        type: "info",
        title: "Update Ready",
        message: `Update ${info.version} has been downloaded.`,
        detail: "The update will be installed when you quit the application.",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(async (result) => {
        if (result.response === 0) {
          // Clear the pending update flag to prevent loops
          this.updateDownloaded = false;
          
          // On Windows, check for processes in other user sessions before proceeding
          if (process.platform === "win32" && this.processManager) {
            const canProceed = await this.checkAndTerminateOtherSessions();
            if (!canProceed) {
              logger.log("[updater] Update cancelled due to processes in other sessions");
              this.updateDownloaded = true; // Restore flag so user can try again
              return;
            }
          }
          
          // Prepare for update by cleaning up all resources
          try {
            if (this.prepareForUpdate) {
              logger.log('[updater] Cleaning up resources before update installation');
              await this.prepareForUpdate();
            }
          } catch (err) {
            logger.error(
              '[updater] Error during cleanup before update:',
              (err as Error).message
            );
            // Continue with update anyway, but add extra delay for Windows
            const delayMs = process.platform === 'win32' ? 2000 : 1000;
            logger.log(`[updater] Adding ${delayMs}ms delay after cleanup error...`);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          
          // Now quit and install
          // Use isSilent=false to show installer UI, isForceRunAfter=true to restart after install
          // On Windows, we need to ensure the app process can be terminated
          logger.log('[updater] Quitting and installing update');
          try {
            electronAutoUpdater.quitAndInstall(false, true);
          } catch (err) {
            logger.error(
              '[updater] Error calling quitAndInstall:',
              (err as Error).message
            );
            // Fallback: force quit the app to avoid before-quit loop
            logger.log('[updater] Attempting force quit as fallback...');
            setTimeout(() => {
              app.exit(0);
            }, 500);
          }
        }
      })
      .catch((err) => {
        logger.error(
          "[updater] Error showing downloaded dialog:",
          (err as Error).message
        );
      });
  }

  /**
   * Start checking for updates periodically
   */
  public start(): void {
    // Only check for updates in production (packaged app)
    if (!app.isPackaged) {
      logger.log("[updater] Skipping update check in development mode");
      return;
    }

    // Clear update cache on startup to prevent stale version detection
    // This helps resolve issues where the app doesn't recognize it's been updated
    this.clearUpdateCache();

    // Check immediately on start (after a short delay to let app initialize)
    setTimeout(() => {
      this.checkForUpdates();
    }, 10000); // 10 seconds delay

    // Then check periodically
    this.updateCheckInterval = setInterval(() => {
      this.checkForUpdates();
    }, this.checkIntervalMs);

    logger.log("[updater] Auto-update checker started");
  }

  /**
   * Stop checking for updates
   */
  public stop(): void {
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
      this.updateCheckInterval = null;
    }
    logger.log("[updater] Auto-update checker stopped");
  }

  /**
   * Check if an update has been downloaded and is pending installation
   */
  public hasPendingUpdate(): boolean {
    return this.updateDownloaded;
  }

  /**
   * Clear the pending update flag (used when starting update installation)
   */
  public clearPendingUpdate(): void {
    this.updateDownloaded = false;
  }

  /**
   * Clear update cache to force fresh version check
   * This helps resolve issues where electron-updater caches stale version info
   */
  public clearUpdateCache(): void {
    try {
      if (this.cacheDir && this.cacheDir !== "default" && fs.existsSync(this.cacheDir)) {
        const files = fs.readdirSync(this.cacheDir);
        for (const file of files) {
          const filePath = path.join(this.cacheDir, file);
          try {
            if (fs.statSync(filePath).isFile()) {
              fs.unlinkSync(filePath);
              logger.log(`[updater] Cleared cache file: ${file}`);
            }
          } catch (err) {
            logger.warn(`[updater] Could not clear cache file ${file}: ${(err as Error).message}`);
          }
        }
        logger.log('[updater] Update cache cleared');
      }
    } catch (err) {
      logger.warn(`[updater] Could not clear update cache: ${(err as Error).message}`);
    }
  }

  /**
   * Check for processes running in other user sessions (Windows only)
   * Returns information about running processes
   */
  public async checkOtherSessions(): Promise<{ hasOtherSessions: boolean; message: string }> {
    if (process.platform !== "win32" || !this.processManager) {
      return { hasOtherSessions: false, message: "Not applicable on this platform" };
    }

    try {
      const processes = await this.processManager.detectAllProcesses();
      const message = await this.processManager.getProcessStatusMessage();
      
      // Check if there are processes from other users (which indicates other sessions)
      const currentUsername = (process.env.USERNAME || process.env.USER || '').toLowerCase();
      const otherUserProcesses = processes.filter(p => 
        p.username.toLowerCase() !== currentUsername
      );
      
      return {
        hasOtherSessions: otherUserProcesses.length > 0,
        message,
      };
    } catch (err) {
      logger.error("[updater] Error checking other sessions:", (err as Error).message);
      return {
        hasOtherSessions: false,
        message: `Error checking processes: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Manually check for updates
   */
  public async checkForUpdates(): Promise<void> {
    if (!app.isPackaged) {
      logger.log("[updater] Skipping update check in development mode");
      if (app.isReady()) {
        dialog
          .showMessageBox({
            type: "info",
            title: "Development Mode",
            message: "Update checking is disabled in development mode.",
          })
          .catch(() => {});
      }
      return;
    }

    try {
      logger.log("[updater] Checking for updates...");
      await electronAutoUpdater.checkForUpdates();
    } catch (err) {
      const errorMessage = (err as Error).message || "";
      // Check if it's a 404 error (update file not found)
      const is404Error =
        errorMessage.includes("404") ||
        errorMessage.includes("Not Found") ||
        errorMessage.includes("Cannot find channel");

      if (is404Error) {
        // 404 means no update file exists yet - this is normal
        logger.log("[updater] No update information available");
      } else {
        // For other errors, log them
        logger.log(`[updater] Update check failed: ${errorMessage}`);
      }
      // Don't show error dialog - errors are handled by the error event handler
    }
  }

  /**
   * Download the available update
   */
  private async downloadUpdate(): Promise<void> {
    try {
      logger.log("[updater] Downloading update...");
      logger.log(`[updater] Cache directory: ${this.cacheDir || "default"}`);
      await electronAutoUpdater.downloadUpdate();
    } catch (err) {
      const errorMessage = (err as Error).message || "";
      const isPermissionError =
        errorMessage.includes("EPERM") ||
        errorMessage.includes("operation not permitted") ||
        errorMessage.includes("permission denied") ||
        errorMessage.includes("EACCES");

      logger.error(
        "[updater] Error downloading update:",
        errorMessage
      );

      if (isPermissionError) {
        dialog.showErrorBox(
          "Update Download Failed - Permission Error",
          "Failed to download update due to permission issues.\n\n" +
          "Possible solutions:\n" +
          "1. Run the app as administrator\n" +
          "2. Check that your user account has write permissions\n" +
          "3. Try downloading the update manually from the website"
        );
      } else {
        dialog.showErrorBox(
          "Update Download Failed",
          `Failed to download update: ${errorMessage}`
        );
      }
    }
  }
}
