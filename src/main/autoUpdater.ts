import { autoUpdater as electronAutoUpdater } from "electron-updater";
import { app, dialog } from "electron";
import { logger } from "./logger";

/**
 * Auto-updater configuration for Cloudflare R2 bucket
 * Uses S3-compatible API
 */
export class AutoUpdater {
  private updateCheckInterval: NodeJS.Timeout | null = null;
  private readonly checkIntervalMs = 60 * 60 * 1000; // Check every hour

  constructor() {
    // Configure auto-updater
    electronAutoUpdater.autoDownload = false; // Don't auto-download, let user choose
    electronAutoUpdater.autoInstallOnAppQuit = true; // Install on quit after download

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

      if (is404Error) {
        // 404 means no update file exists yet - this is normal for first release
        // or when update server hasn't been set up yet
        logger.log(
          "[updater] No update information available (update server not configured or first release)"
        );
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
      .then((result) => {
        if (result.response === 0) {
          electronAutoUpdater.quitAndInstall(false, true);
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
      await electronAutoUpdater.downloadUpdate();
    } catch (err) {
      logger.error(
        "[updater] Error downloading update:",
        (err as Error).message
      );
      dialog.showErrorBox(
        "Update Download Failed",
        `Failed to download update: ${(err as Error).message}`
      );
    }
  }
}
