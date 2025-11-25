import { autoUpdater as electronAutoUpdater } from "electron-updater";
import { app, dialog } from "electron";
import path from "path";
import os from "os";
import fs from "fs";
import { logger } from "./logger";

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

  constructor(prepareForUpdate?: () => Promise<void>) {
    this.prepareForUpdate = prepareForUpdate || null;
    // Configure auto-updater
    electronAutoUpdater.autoDownload = false; // Don't auto-download, let user choose
    electronAutoUpdater.autoInstallOnAppQuit = true; // Install on quit after download

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

    // Setup event handlers
    this.setupEventHandlers();
  }

  /**
   * Setup auto-updater event handlers
   */
  private setupEventHandlers(): void {
    electronAutoUpdater.on("checking-for-update", () => {
      logger.log("[updater] Checking for updates...");
    });

    electronAutoUpdater.on("update-available", (info) => {
      logger.log(`[updater] Update available: ${info.version}`);
      this.showUpdateAvailableDialog(info);
    });

    electronAutoUpdater.on("update-not-available", (info) => {
      logger.log(
        `[updater] Update not available. Current version: ${info.version}`
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
