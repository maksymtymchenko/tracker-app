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
  // Maximum duration before forcing a periodic record (5 minutes)
  private readonly maxSessionDuration = 5 * 60 * 1000;

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
      const timeoutMs = process.platform === "win32" ? 10000 : 5000;
      const active = await Promise.race([
        this.getActiveWindowSafe(),
        new Promise<ActiveWindowInfo>((resolve) => {
          setTimeout(() => resolve({ application: "", title: "" }), timeoutMs);
        }),
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
      // Check if we need to record time: window changed, idle state changed, or max session duration reached
      const shouldRecord =
        windowChanged ||
        (isIdle && !this.idleActive) ||
        duration >= this.maxSessionDuration;

      if (shouldRecord) {
        if (duration >= this.opts.minActivityDuration && this.lastWindow) {
          try {
            const data: WindowActivityData = {
              application: this.lastWindow.application || "Unknown",
              title: this.lastWindow.title || "",
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
          } catch (err) {
            console.error(
              "[tracker] Error creating window activity event:",
              (err as Error).message
            );
            // Continue - don't crash the tracker
          }
        }
        // Reset timestamp after recording
        if (windowChanged) {
          // Window changed - update to new window
          this.lastWindow = active;
          this.lastTimestamp = now;
          this.idleActive = false;
          this.lastActivityAt = now;
        } else if (isIdle) {
          // Idle state changed - keep same window, reset timestamp
          this.lastTimestamp = now;
          this.idleActive = true;
          this.lastActivityAt = now;
        } else if (duration >= this.maxSessionDuration) {
          // Periodic recording - window hasn't changed, so keep the same window but reset timestamp
          // This ensures long sessions are recorded in chunks
          this.lastTimestamp = now;
          this.lastActivityAt = now;
        }
      }

      // Do not update lastActivityAt on every tick; only on transitions above
    } catch (err) {
      // Log error but don't let it crash the app
      console.error("[tracker] activityTracker tick error:", err);
    }
  }

  private equals(a: ActiveWindowInfo, b: ActiveWindowInfo): boolean {
    return a.application === b.application && a.title === b.title;
  }

  private async getActiveWindowSafe(): Promise<ActiveWindowInfo> {
    try {
      // Add timeout wrapper to prevent hanging (longer on Windows, shorter on macOS)
      const timeoutMs = process.platform === "win32" ? 8000 : 3000;
      return await Promise.race([
        this.getActiveWindowSafeInternal(),
        new Promise<ActiveWindowInfo>((resolve) => {
          setTimeout(() => resolve({ application: "", title: "" }), timeoutMs);
        }),
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
            const appName = info.owner.name || "Unknown";
            const title = info.title || "";
            console.log(`[tracker] active-win success: ${appName} - ${title}`);
            return { application: appName, title: title };
          }
          console.log(`[tracker] active-win returned no owner info`);
          return null;
        })(),
        new Promise<ActiveWindowInfo | null>((resolve) => {
          setTimeout(() => {
            console.log(`[tracker] active-win timeout after 2s`);
            resolve(null);
          }, 2000);
        }),
      ]);
      return result;
    } catch (err) {
      console.log(`[tracker] active-win error:`, (err as Error).message);
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
        maxBuffer: 1024 * 1024,
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
        const appName = info.owner.name || "Unknown";
        const title = info.title || "";
        console.log(`[tracker] active-win detected: ${appName} - ${title}`);
        return {
          application: appName,
          title: title,
        };
      }
    } catch (err) {
      console.log(
        `[tracker] active-win failed, using fallback:`,
        (err as Error).message
      );
      // ignore and fallback
    }

    // Fallback: filter out system processes and find user applications
    try {
      // Add timeout to prevent hanging on process list
      const processes = await Promise.race([
        si.processes(),
        new Promise<any>((resolve) => {
          setTimeout(() => {
            console.log("[tracker] si.processes() timeout after 3s");
            resolve({ list: [] });
          }, 3000);
        }),
      ]);

      if (!processes || !processes.list || processes.list.length === 0) {
        console.log("[tracker] No processes available, returning Unknown");
        return { application: "Unknown", title: "" };
      }

      // System processes to exclude
      const systemProcesses = new Set([
        "System Idle Process",
        "System",
        "smss.exe",
        "csrss.exe",
        "wininit.exe",
        "winlogon.exe",
        "services.exe",
        "lsass.exe",
        "svchost.exe",
        "dwm.exe",
        "explorer.exe", // Usually not the active app
        "conhost.exe",
        "RuntimeBroker.exe",
        "SearchIndexer.exe",
        "SearchProtocolHost.exe",
        "SearchFilterHost.exe",
      ]);

      // Find processes with windows (non-system processes)
      // Filter by: not a system process, has reasonable CPU/memory usage, is a user application
      let userProcesses: any[] = [];
      try {
        userProcesses = processes.list.filter((p: any) => {
          try {
            const processName = p.name || "";

            // Exclude system processes
            if (systemProcesses.has(processName)) return false;

            // Exclude processes with very low memory (likely background/system)
            if ((p.mem || 0) < 1) return false;

            // Prefer processes with some CPU activity (but not too high to avoid system processes)
            const cpu = (p as any).pcpu || p.cpu || 0;
            if (cpu > 50) return false; // Too high might be system

            return true;
          } catch {
            return false; // Skip invalid processes
          }
        });
      } catch (filterErr) {
        console.error(
          "[tracker] Error filtering processes:",
          (filterErr as Error).message
        );
        // Continue with empty list
      }

      // Sort by memory usage (user apps typically use more memory) or CPU
      try {
        userProcesses.sort((a, b) => {
          try {
            const memA = a.mem || 0;
            const memB = b.mem || 0;
            if (Math.abs(memA - memB) > 10) {
              return memB - memA; // Higher memory first
            }
            // If memory is similar, use CPU
            const cpuA = (a as any).pcpu || a.cpu || 0;
            const cpuB = (b as any).pcpu || b.cpu || 0;
            return cpuB - cpuA;
          } catch {
            return 0; // Keep order if comparison fails
          }
        });
      } catch (sortErr) {
        console.error(
          "[tracker] Error sorting processes:",
          (sortErr as Error).message
        );
        // Continue without sorting
      }

      const top = userProcesses[0];
      if (top && top.name) {
        const appName = top.name || "Unknown";
        console.log(
          `[tracker] fallback detected: ${appName} (mem: ${top.mem}MB, cpu: ${
            (top as any).pcpu || top.cpu
          }%)`
        );
        return { application: appName, title: appName };
      }

      // Last resort: return first non-system process
      try {
        const firstNonSystem = processes.list.find((p: any) => {
          const name = p.name || "";
          return name && !systemProcesses.has(name);
        });
        if (firstNonSystem && firstNonSystem.name) {
          console.log(`[tracker] fallback last resort: ${firstNonSystem.name}`);
          return {
            application: firstNonSystem.name,
            title: firstNonSystem.name,
          };
        }
      } catch {
        // Ignore errors in last resort
      }

      console.log("[tracker] No suitable process found, returning Unknown");
      return { application: "Unknown", title: "" };
    } catch (err) {
      console.error(
        "[tracker] Windows fallback error:",
        (err as Error).message,
        err
      );
      // Return empty to prevent crash
      return { application: "Unknown", title: "" };
    }
  }

  private async getActiveWindowLinuxFallback(): Promise<ActiveWindowInfo> {
    try {
      const processes = await si.processes();
      const top =
        processes.list.find((p) =>
          (p as any).pcpu ? (p as any).pcpu > 10 : p.cpu > 10
        ) || processes.list[0];
      return { application: top?.name || "Unknown", title: top?.name || "" };
    } catch {
      return { application: "Unknown", title: "" };
    }
  }
}
