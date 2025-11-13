import os from "os";
import { spawnSync } from "child_process";
import si from "systeminformation";
import { BaseEvent, WindowActivityData } from "../types/events";

export interface ActivityTrackerOptions {
  username: string;
  deviceId: string;
  domain: "windows-desktop";
  intervalMs: number;
  minActivityDuration: number;
  maxIdleTime: number;
}

export type ActivityHandler = (event: BaseEvent) => void;

interface ActiveWindowInfo {
  application: string;
  title: string;
  path?: string;
}

export class ActivityTracker {
  private timer: NodeJS.Timeout | null = null;
  private lastWindow: ActiveWindowInfo | null = null;
  private lastTimestamp = Date.now();
  private lastActivityAt = Date.now();
  private idleActive = false;

  constructor(
    private readonly opts: ActivityTrackerOptions,
    private readonly onEvent: ActivityHandler
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => this.tick().catch(() => {}),
      this.opts.intervalMs
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    try {
      const now = Date.now();
      // Add timeout to prevent hanging (longer timeout on Windows, shorter on macOS)
      const timeoutMs = process.platform === 'win32' ? 10000 : 5000;
      const active = await Promise.race([
        this.getActiveWindowSafe(),
        new Promise<ActiveWindowInfo>((resolve) => {
          setTimeout(() => resolve({ application: "", title: "" }), timeoutMs);
        })
      ]);
      const isIdle = now - this.lastActivityAt > this.opts.maxIdleTime;

      if (!this.lastWindow) {
        this.lastWindow = active;
        this.lastTimestamp = now;
        this.lastActivityAt = now;
        return;
      }

      const windowChanged = !this.equals(active, this.lastWindow);
      const duration = now - this.lastTimestamp;
      if (windowChanged || (isIdle && !this.idleActive)) {
        if (duration >= this.opts.minActivityDuration) {
          const data: WindowActivityData = {
            application: this.lastWindow.application,
            title: this.lastWindow.title,
            duration,
            isIdle,
          };
          const event: BaseEvent = {
            username: this.opts.username,
            deviceId: this.opts.deviceId,
            domain: this.opts.domain,
            timestamp: new Date().toISOString(),
            type: "window_activity",
            durationMs: duration,
            data,
          };
          this.onEvent(event);
        }
        this.lastWindow = active;
        this.lastTimestamp = now;
        if (windowChanged) {
          this.idleActive = false;
          this.lastActivityAt = now;
        } else if (isIdle) {
          this.idleActive = true;
          this.lastActivityAt = now;
        }
      }

      // Do not update lastActivityAt on every tick; only on transitions above
    } catch (err) {
      // Log error but don't let it crash the app
      console.error('[tracker] activityTracker tick error:', err);
    }
  }

  private equals(a: ActiveWindowInfo, b: ActiveWindowInfo): boolean {
    return a.application === b.application && a.title === b.title;
  }

  private async getActiveWindowSafe(): Promise<ActiveWindowInfo> {
    try {
      // Add timeout wrapper to prevent hanging (longer on Windows, shorter on macOS)
      const timeoutMs = process.platform === 'win32' ? 8000 : 3000;
      return await Promise.race([
        this.getActiveWindowSafeInternal(),
        new Promise<ActiveWindowInfo>((resolve) => {
          setTimeout(() => resolve({ application: "", title: "" }), timeoutMs);
        })
      ]);
    } catch {
      return { application: "", title: "" };
    }
  }

  private async getActiveWindowSafeInternal(): Promise<ActiveWindowInfo> {
    try {
      // Try cross-platform library first
      const fromLib = await this.tryActiveWin();
      if (fromLib) return fromLib;
      // Platform-specific fallbacks
      if (process.platform === "darwin") {
        return await this.getActiveWindowMac();
      }
      if (process.platform === "win32") {
        return await this.getActiveWindowWindowsFallback();
      }
      return await this.getActiveWindowLinuxFallback();
    } catch {
      return { application: "", title: "" };
    }
  }

  private async tryActiveWin(): Promise<ActiveWindowInfo | null> {
    try {
      // Add timeout to prevent hanging on import or getActive call
      const result = await Promise.race([
        (async () => {
          const mod: any = await import("active-win");
          const getActive = mod.default || mod;
          const info = await getActive();
          if (info && info.owner) {
            return { application: info.owner.name || "Unknown", title: info.title || "" };
          }
          return null;
        })(),
        new Promise<ActiveWindowInfo | null>((resolve) => {
          setTimeout(() => resolve(null), 2000);
        })
      ]);
      return result;
    } catch {
      return null;
    }
  }

  private async getActiveWindowMac(): Promise<ActiveWindowInfo> {
    try {
      const osa = `
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
        end tell
        tell application frontApp
          try
            set windowTitle to name of front window
          on error
            set windowTitle to ""
          end try
        end tell
        return frontApp & "\n" & windowTitle
      `;
      // Add timeout to spawnSync to prevent hanging
      const res = spawnSync("osascript", ["-e", osa], {
        timeout: 2000,
        maxBuffer: 1024 * 1024
      });
      if (res.error) {
        return { application: "", title: "" };
      }
      const out = res.stdout?.toString()?.trim() || "";
      const [app, title] = out.split("\n");
      return { application: app || "", title: title || "" };
    } catch {
      return { application: "", title: "" };
    }
  }

  private async getActiveWindowWindowsFallback(): Promise<ActiveWindowInfo> {
    // Prefer precise foreground detection via active-win; fallback to heuristic
    try {
      const mod: any = await import("active-win");
      const getActive = mod.default || mod;
      const info = await getActive();
      if (info && info.owner) {
        return {
          application: info.owner.name || "Unknown",
          title: info.title || "",
        };
      }
    } catch {
      // ignore and fallback
    }
    try {
      const processes = await si.processes();
      const top = processes.list.find((p) => (p as any).pcpu ? (p as any).pcpu > 10 : p.cpu > 10) || processes.list[0];
      return { application: top?.name || "Unknown", title: top?.name || "" };
    } catch {
      return { application: "Unknown", title: "" };
    }
  }

  private async getActiveWindowLinuxFallback(): Promise<ActiveWindowInfo> {
    try {
      const processes = await si.processes();
      const top = processes.list.find((p) => (p as any).pcpu ? (p as any).pcpu > 10 : p.cpu > 10) || processes.list[0];
      return { application: top?.name || "Unknown", title: top?.name || "" };
    } catch {
      return { application: "Unknown", title: "" };
    }
  }
}
