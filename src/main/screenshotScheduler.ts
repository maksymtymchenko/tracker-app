import { powerMonitor, screen } from "electron";
import { Screenshotter } from "./screenshotter";
import { logger } from "./logger";
import { ActiveWindowInfo } from "./activityTracker";

export type ScreenshotTargetMode = "primary" | "active" | "all";

interface ScreenshotSchedulerOptions {
  screenshotter: Screenshotter;
  minIntervalMs: number;
  timeBasedIntervalMs: number;
  windowChangeDebounceMs: number;
  maxScreenshotsPerHour: number;
  resumeCaptureOnActive: boolean;
  idleThresholdMs: number;
  screenshotTarget: ScreenshotTargetMode;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

class IdleDetector {
  private timer: NodeJS.Timeout | null = null;
  private lastState: boolean | null = null;

  constructor(
    private readonly thresholdMs: number,
    private readonly onChange: (isIdle: boolean) => void
  ) {}

  start(): void {
    this.check();
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), 2000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastState = null;
  }

  private check(): void {
    try {
      const idleSeconds = powerMonitor.getSystemIdleTime();
      const isIdle = idleSeconds * 1000 >= this.thresholdMs;
      if (this.lastState === isIdle) {
        return;
      }
      this.lastState = isIdle;
      this.onChange(isIdle);
    } catch (err) {
      logger.error(
        "[tracker] IdleDetector error:",
        (err as Error).message,
        "continuing without idle change"
      );
    }
  }
}

export class ScreenshotScheduler {
  private idleDetector: IdleDetector;
  private timeBasedTimer: NodeJS.Timeout | null = null;
  private windowChangeTimer: NodeJS.Timeout | null = null;
  private lastCaptureAt = 0;
  private hourlyTimestamps: number[] = [];
  private isIdle = false;
  private latestWindowInfo: ActiveWindowInfo | null = null;

  constructor(private readonly opts: ScreenshotSchedulerOptions) {
    this.idleDetector = new IdleDetector(
      this.opts.idleThresholdMs,
      this.handleIdleChange.bind(this)
    );
  }

  start(): void {
    this.idleDetector.start();
    this.isIdle = false;
    this.scheduleNextTimeShot(this.opts.timeBasedIntervalMs);
    this.requestCapture("tracking_start").catch(() => {});
  }

  stop(): void {
    this.idleDetector.stop();
    this.cancelTimeBasedTimer();
    this.cancelWindowChangeTimer();
    this.hourlyTimestamps = [];
    this.lastCaptureAt = 0;
  }

  updateActiveWindow(info: ActiveWindowInfo): void {
    this.latestWindowInfo = info;
  }

  handleWindowChange(): void {
    if (this.isIdle) {
      return;
    }
    if (this.windowChangeTimer) {
      clearTimeout(this.windowChangeTimer);
    }
    logger.log(
      `[tracker] Window change detected - scheduling screenshot after ${Math.round(
        this.opts.windowChangeDebounceMs / 1000
      )}s`
    );
    this.windowChangeTimer = setTimeout(() => {
      this.windowChangeTimer = null;
      this.requestCapture("window_change").catch(() => {});
    }, this.opts.windowChangeDebounceMs);
  }

  async requestCapture(reason: string): Promise<void> {
    if (this.isIdle && reason !== "manual" && reason !== "tracking_start" && reason !== "resume") {
      logger.log(`[tracker] Screenshot skipped (${reason}): user is idle`);
      return;
    }
    if (!this.canCapture()) {
      return;
    }
    const screenIndex = await this.resolveScreenIndex();
    try {
      await this.opts.screenshotter.capture(reason, screenIndex);
      const now = Date.now();
      this.lastCaptureAt = now;
      this.hourlyTimestamps.push(now);
    } catch (err) {
      logger.error(
        `[tracker] screenshot failed (${reason}):`,
        (err as Error).message
      );
    }
  }

  private canCapture(): boolean {
    const now = Date.now();
    if (now - this.lastCaptureAt < this.opts.minIntervalMs) {
      logger.log(
        `[tracker] Screenshot skipped: rate limit (${Math.round(
          (now - this.lastCaptureAt) / 1000
        )}s since last, require ${Math.round(this.opts.minIntervalMs / 1000)}s)`
      );
      return false;
    }
    this.trimHourly(now);
    if (this.hourlyTimestamps.length >= this.opts.maxScreenshotsPerHour) {
      logger.log(
        `[tracker] Screenshot skipped: max ${this.opts.maxScreenshotsPerHour} per hour reached`
      );
      return false;
    }
    return true;
  }

  private trimHourly(now: number): void {
    this.hourlyTimestamps = this.hourlyTimestamps.filter(
      (timestamp) => now - timestamp <= ONE_HOUR_MS
    );
  }

  private scheduleNextTimeShot(delayMs: number): void {
    this.cancelTimeBasedTimer();
    if (this.isIdle || delayMs <= 0) {
      return;
    }
    this.timeBasedTimer = setTimeout(async () => {
      await this.requestCapture("time_interval");
      this.scheduleNextTimeShot(this.opts.timeBasedIntervalMs);
    }, delayMs);
  }

  private cancelTimeBasedTimer(): void {
    if (this.timeBasedTimer) {
      clearTimeout(this.timeBasedTimer);
      this.timeBasedTimer = null;
    }
  }

  private cancelWindowChangeTimer(): void {
    if (this.windowChangeTimer) {
      clearTimeout(this.windowChangeTimer);
      this.windowChangeTimer = null;
    }
  }

  private handleIdleChange(isIdle: boolean): void {
    this.isIdle = isIdle;
    if (isIdle) {
      logger.log("[tracker] Idle detected - pausing scheduled screenshots");
      this.cancelTimeBasedTimer();
      this.cancelWindowChangeTimer();
      return;
    }
    logger.log("[tracker] Activity resumed - resuming scheduled screenshots");
    this.scheduleNextTimeShot(this.opts.timeBasedIntervalMs);
    if (this.opts.resumeCaptureOnActive) {
      this.requestCapture("resume").catch(() => {});
    }
  }

  private async resolveScreenIndex(): Promise<number | undefined> {
    if (this.opts.screenshotTarget === "all") {
      return undefined;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const screenshot = require("screenshot-desktop");
      if (!screenshot.listDisplays) {
        return undefined;
      }
      const displays: any[] = await screenshot.listDisplays();
      if (!displays || displays.length === 0) {
        return undefined;
      }
      let targetBounds: { x: number; y: number; width: number; height: number } | undefined;
      if (this.opts.screenshotTarget === "primary") {
        targetBounds = screen.getPrimaryDisplay()?.bounds;
      } else if (this.opts.screenshotTarget === "active") {
        if (this.latestWindowInfo?.bounds) {
          targetBounds = this.latestWindowInfo.bounds;
        } else {
          targetBounds = screen.getPrimaryDisplay()?.bounds;
        }
      }
      if (!targetBounds) {
        return undefined;
      }
      const matchIndex = displays.findIndex((display) =>
        this.boundsMatchDisplay(display, targetBounds!)
      );
      if (matchIndex >= 0) {
        return matchIndex;
      }
      // fallback to primary display index (zero)
      return this.opts.screenshotTarget === "primary" ? 0 : undefined;
    } catch (err) {
      logger.error(
        "[tracker] Unable to resolve target display for screenshot:",
        (err as Error).message
      );
      return undefined;
    }
  }

  private boundsMatchDisplay(
    display: any,
    target: { x: number; y: number; width: number; height: number }
  ): boolean {
    const rect = this.normalizeDisplay(display);
    if (!rect) return false;
    const targetCenterX = target.x + target.width / 2;
    const targetCenterY = target.y + target.height / 2;
    return (
      targetCenterX >= rect.x &&
      targetCenterX <= rect.x + rect.width &&
      targetCenterY >= rect.y &&
      targetCenterY <= rect.y + rect.height
    );
  }

  private normalizeDisplay(display: any):
    | { x: number; y: number; width: number; height: number }
    | null {
    if (!display) return null;
    if (display.bounds) {
      return {
        x: typeof display.bounds.x === "number" ? display.bounds.x : 0,
        y: typeof display.bounds.y === "number" ? display.bounds.y : 0,
        width:
          typeof display.bounds.width === "number"
            ? display.bounds.width
            : typeof display.width === "number"
            ? display.width
            : 0,
        height:
          typeof display.bounds.height === "number"
            ? display.bounds.height
            : typeof display.height === "number"
            ? display.height
            : 0,
      };
    }
    if (
      typeof display.left === "number" &&
      typeof display.top === "number" &&
      typeof display.width === "number" &&
      typeof display.height === "number"
    ) {
      return {
        x: display.left,
        y: display.top,
        width: display.width,
        height: display.height,
      };
    }
    if (
      typeof display.left === "number" &&
      typeof display.top === "number" &&
      typeof display.right === "number" &&
      typeof display.bottom === "number"
    ) {
      return {
        x: display.left,
        y: display.top,
        width: display.right - display.left,
        height: display.bottom - display.top,
      };
    }
    return null;
  }
}
