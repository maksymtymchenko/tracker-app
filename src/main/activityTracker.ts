import os from "os";
import path from "path";
import { execFile, spawnSync } from "child_process";
import si from "systeminformation";
import { powerMonitor } from "electron";
import {
  BaseEvent,
  LaunchTrigger,
  ProcessContext,
  ProcessDetectionSource,
  ProcessOrigin,
  WindowActivityData,
} from "../types/events";

export interface ActiveWindowInfo {
  application: string;
  title: string;
  path?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  pid?: number;
  processName?: string;
  parentPid?: number;
  user?: string;
  detectionSource?: ProcessDetectionSource;
}

export interface ActivityTrackerOptions {
  username: string;
  deviceId: string;
  domain: "windows-desktop";
  intervalMs: number;
  minActivityDuration: number;
  maxIdleTime: number;
  onActiveWindow?: (info: ActiveWindowInfo) => void;
  onWindowChange?: (info: ActiveWindowInfo) => void;
}

export type ActivityHandler = (event: BaseEvent) => void;

export class ActivityTracker {
  private timer: NodeJS.Timeout | null = null;
  private lastWindow: ActiveWindowInfo | null = null;
  private lastTimestamp = Date.now();
  private lastActivityAt = Date.now();
  private idleActive = false;
  private appNameCache = new Map<string, string>();
  private processInfoCache = new Map<
    number,
    { info: Partial<ProcessContext>; at: number }
  >();
  private readonly processInfoTtlMs = 30 * 1000;
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
      this.opts.onActiveWindow?.(active);
      const isIdle = this.isSystemIdle(now);

      if (!this.lastWindow) {
        this.lastWindow = active;
        this.lastTimestamp = now;
        this.lastActivityAt = now;
        this.idleActive = isIdle;
        return;
      }

      if (this.idleActive && !isIdle) {
        // Resume after idle: reset timers to avoid counting idle time as activity
        this.idleActive = false;
        this.lastTimestamp = now;
        this.lastActivityAt = now;
        if (!this.equals(active, this.lastWindow)) {
          this.lastWindow = active;
          this.opts.onWindowChange?.(active);
        }
        return;
      }

      const windowChanged = !this.equals(active, this.lastWindow);
      const duration = now - this.lastTimestamp;
      // Check if we need to record time: window changed, idle state changed, or max session duration reached
      const shouldRecord =
        windowChanged ||
        (isIdle && !this.idleActive) ||
        (!isIdle && duration >= this.maxSessionDuration);

      if (shouldRecord) {
        if (duration >= this.opts.minActivityDuration && this.lastWindow) {
          try {
            const processContext = await this.buildProcessContext(
              this.lastWindow,
              isIdle
            );
            const data: WindowActivityData = {
              application: this.lastWindow.application || "Unknown",
              title: this.lastWindow.title || "",
              duration,
              isIdle,
              bounds: this.lastWindow.bounds,
              path: this.lastWindow.path,
              process: processContext,
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
          this.idleActive = isIdle;
          if (!isIdle) {
            this.lastActivityAt = now;
          }
          this.opts.onWindowChange?.(active);
        } else if (isIdle) {
          // Idle state changed - keep same window, reset timestamp
          this.lastTimestamp = now;
          this.idleActive = true;
        } else if (duration >= this.maxSessionDuration) {
          // Periodic recording - window hasn't changed, so keep the same window but reset timestamp
          // This ensures long sessions are recorded in chunks
          this.lastTimestamp = now;
        }
      }

      // Do not update lastActivityAt on every tick; only on transitions above
    } catch (err) {
      // Log error but don't let it crash the app
      console.error("[tracker] activityTracker tick error:", err);
    }
  }

  private equals(a: ActiveWindowInfo, b: ActiveWindowInfo): boolean {
    const sameApp = a.application === b.application;
    const sameTitle = a.title === b.title;
    const samePid = (a.pid || -1) === (b.pid || -1);
    const samePath = (a.path || "") === (b.path || "");
    const sameBounds =
      (!!a.bounds && !!b.bounds)
        ? a.bounds.x === b.bounds.x &&
          a.bounds.y === b.bounds.y &&
          a.bounds.width === b.bounds.width &&
          a.bounds.height === b.bounds.height
        : !a.bounds && !b.bounds;
    return sameApp && sameTitle && samePid && samePath && sameBounds;
  }

  private normalizeAppName(name: string): string {
    return name.replace(/\.exe$/i, "").trim();
  }

  private resolveWindowsAppName(name: string, execPath?: string): string {
    const normalized = this.normalizeAppName(name);
    if (process.platform !== "win32" || !execPath) {
      return normalized;
    }
    const cached = this.appNameCache.get(execPath);
    if (cached) return cached;
    const friendly = this.getWindowsProductName(execPath);
    const resolved = friendly || normalized;
    this.appNameCache.set(execPath, resolved);
    return resolved;
  }

  private getWindowsProductName(execPath: string): string | null {
    try {
      const safePath = execPath.replace(/'/g, "''");
      const cmd =
        `$p = Get-Item -LiteralPath '${safePath}'; ` +
        `$n = $p.VersionInfo.ProductName; ` +
        `if (-not $n) { $n = $p.VersionInfo.FileDescription }; ` +
        `if (-not $n) { $n = $p.BaseName }; ` +
        `Write-Output $n`;
      const res = spawnSync("powershell", ["-NoProfile", "-Command", cmd], {
        timeout: 1500,
        maxBuffer: 1024 * 1024,
      });
      if (res.error) return null;
      const out = res.stdout?.toString()?.trim() || "";
      return out || null;
    } catch {
      return null;
    }
  }

  private isSystemIdle(now: number): boolean {
    try {
      const idleSeconds = powerMonitor.getSystemIdleTime();
      if (Number.isFinite(idleSeconds)) {
        return idleSeconds * 1000 >= this.opts.maxIdleTime;
      }
    } catch {
      // Fall back to internal tracking
    }
    return now - this.lastActivityAt > this.opts.maxIdleTime;
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
      const result = await Promise.race<ActiveWindowInfo | null>([
        (async () => {
          const mod: any = await import("active-win");
          const getActive = mod.default || mod;
          const info = await getActive();
          if (info && info.owner) {
            const ownerName = info.owner.name || "Unknown";
            const appName = this.resolveWindowsAppName(
              ownerName,
              info.owner.path || undefined
            );
            const title = info.title || "";
            console.log(`[tracker] active-win success: ${appName} - ${title}`);
            const bounds = info.bounds
              ? {
                  x: info.bounds.x,
                  y: info.bounds.y,
                  width: info.bounds.width,
                  height: info.bounds.height,
                }
              : undefined;
            const path = info.owner.path || undefined;
            const windowInfo: ActiveWindowInfo = {
              application: appName,
              title: title,
              bounds,
              path,
              pid: info.owner.processId || undefined,
              processName: ownerName,
              detectionSource: "active-win",
            };
            return windowInfo;
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
        return { application: "", title: "", detectionSource: "mac-osa" };
      }
      const out = res.stdout?.toString()?.trim() || "";
      const [app, title] = out.split("\n");
      return {
        application: app || "",
        title: title || "",
        detectionSource: "mac-osa",
      };
    } catch {
      return { application: "", title: "", detectionSource: "mac-osa" };
    }
  }

  private async getActiveWindowWindowsFallback(): Promise<ActiveWindowInfo> {
    // Prefer precise foreground detection via active-win; fallback to heuristic
    try {
      const mod: any = await import("active-win");
      const getActive = mod.default || mod;
      const info = await getActive();
      if (info && info.owner) {
        const appName = this.resolveWindowsAppName(
          info.owner.name || "Unknown",
          info.owner.path || undefined
        );
        const title = info.title || "";
        console.log(`[tracker] active-win detected: ${appName} - ${title}`);
        return {
          application: appName,
          title: title,
          pid: info.owner.processId || undefined,
          processName: info.owner.name || undefined,
          path: info.owner.path || undefined,
          detectionSource: "active-win",
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
        return {
          application: "Unknown",
          title: "",
          detectionSource: "windows-fallback",
        };
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
        const appName = this.resolveWindowsAppName(
          top.name || "Unknown",
          top.path || undefined
        );
        console.log(
          `[tracker] fallback detected: ${appName} (mem: ${top.mem}MB, cpu: ${
            (top as any).pcpu || top.cpu
          }%)`
        );
        return {
          application: appName,
          title: appName,
          pid: top.pid || undefined,
          processName: top.name || undefined,
          parentPid: top.parentPid || undefined,
          user: top.user || undefined,
          path: top.path || undefined,
          detectionSource: "windows-fallback",
        };
      }

      // Last resort: return first non-system process
      try {
        const firstNonSystem = processes.list.find((p: any) => {
          const name = p.name || "";
          return name && !systemProcesses.has(name);
        });
        if (firstNonSystem && firstNonSystem.name) {
          const appName = this.resolveWindowsAppName(
            firstNonSystem.name,
            firstNonSystem.path || undefined
          );
          console.log(`[tracker] fallback last resort: ${appName}`);
          return {
            application: appName,
            title: appName,
            pid: firstNonSystem.pid || undefined,
            processName: firstNonSystem.name || undefined,
            parentPid: firstNonSystem.parentPid || undefined,
            user: firstNonSystem.user || undefined,
            path: firstNonSystem.path || undefined,
            detectionSource: "windows-fallback",
          };
        }
      } catch {
        // Ignore errors in last resort
      }

      console.log("[tracker] No suitable process found, returning Unknown");
      return {
        application: "Unknown",
        title: "",
        detectionSource: "windows-fallback",
      };
    } catch (err) {
      console.error(
        "[tracker] Windows fallback error:",
        (err as Error).message,
        err
      );
      // Return empty to prevent crash
      return {
        application: "Unknown",
        title: "",
        detectionSource: "windows-fallback",
      };
    }
  }

  private async getActiveWindowLinuxFallback(): Promise<ActiveWindowInfo> {
    try {
      const processes = await si.processes();
      const top =
        processes.list.find((p) =>
          (p as any).pcpu ? (p as any).pcpu > 10 : p.cpu > 10
        ) || processes.list[0];
      return {
        application: top?.name || "Unknown",
        title: top?.name || "",
        pid: top?.pid || undefined,
        processName: top?.name || undefined,
        parentPid: top?.parentPid || undefined,
        user: top?.user || undefined,
        path: top?.path || undefined,
        detectionSource: "linux-fallback",
      };
    } catch {
      return {
        application: "Unknown",
        title: "",
        detectionSource: "linux-fallback",
      };
    }
  }

  private async buildProcessContext(
    info: ActiveWindowInfo,
    isIdle: boolean
  ): Promise<ProcessContext | undefined> {
    const context: ProcessContext = {
      pid: info.pid,
      ppid: info.parentPid,
      processName: info.processName,
      executablePath: info.path,
      user: info.user,
      detectionSource: info.detectionSource || "unknown",
    };

    if (typeof info.pid === "number") {
      const cached = await this.getProcessInfo(info.pid);
      if (cached) {
        Object.assign(context, cached);
      }
    }

    const classification = this.classifyProcessContext(context, isIdle);
    Object.assign(context, classification);

    return context;
  }

  private async getProcessInfo(
    pid: number
  ): Promise<Partial<ProcessContext> | null> {
    const now = Date.now();
    const cached = this.processInfoCache.get(pid);
    if (cached && now - cached.at < this.processInfoTtlMs) {
      return cached.info;
    }

    const fromSi = await this.getProcessInfoFromSystemInformation(pid);
    const fromWin =
      process.platform === "win32"
        ? await this.getProcessInfoFromWindows(pid)
        : null;
    const merged = { ...fromSi, ...fromWin };
    if (Object.keys(merged).length === 0) {
      return null;
    }
    this.processInfoCache.set(pid, { info: merged, at: now });
    return merged;
  }

  private async getProcessInfoFromSystemInformation(
    pid: number
  ): Promise<Partial<ProcessContext> | null> {
    try {
      const processes = await Promise.race([
        si.processes(),
        new Promise<any>((resolve) => {
          setTimeout(() => resolve(null), 1500);
        }),
      ]);
      if (!processes?.list) return null;
      const found = processes.list.find((p: any) => p.pid === pid);
      if (!found) return null;
      return {
        processName: found.name || undefined,
        ppid: found.parentPid || undefined,
        user: found.user || undefined,
        executablePath: found.path || undefined,
      };
    } catch {
      return null;
    }
  }

  private async getProcessInfoFromWindows(
    pid: number
  ): Promise<Partial<ProcessContext> | null> {
    const cmd =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
      `if (-not $p) { exit 0 }; ` +
      `$pp = $null; ` +
      `if ($p.ParentProcessId) { ` +
      `$pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"; ` +
      `}; ` +
      `$owner = $null; ` +
      `try { $owner = $p.GetOwner() } catch {}; ` +
      `$ownerName = ""; ` +
      `if ($owner -and $owner.User) { ` +
      `if ($owner.Domain) { $ownerName = "$($owner.Domain)\\$($owner.User)" } ` +
      `else { $ownerName = "$($owner.User)" } ` +
      `}; ` +
      `$out = [pscustomobject]@{ ` +
      `sessionId = $p.SessionId; ` +
      `parentPid = $p.ParentProcessId; ` +
      `parentName = if ($pp) { $pp.Name } else { "" }; ` +
      `name = $p.Name; ` +
      `path = $p.ExecutablePath; ` +
      `user = $ownerName; ` +
      `}; ` +
      `$out | ConvertTo-Json -Compress`;

    try {
      const stdout = await this.execFileWithTimeout("powershell", [
        "-NoProfile",
        "-Command",
        cmd,
      ]);
      const trimmed = stdout.trim();
      if (!trimmed) return null;
      const parsed = JSON.parse(trimmed) as {
        sessionId?: number;
        parentPid?: number;
        parentName?: string;
        name?: string;
        path?: string;
        user?: string;
      };
      return {
        sessionId: parsed.sessionId,
        ppid: parsed.parentPid,
        parentName: parsed.parentName || undefined,
        processName: parsed.name || undefined,
        executablePath: parsed.path || undefined,
        user: parsed.user || undefined,
      };
    } catch {
      return null;
    }
  }

  private execFileWithTimeout(
    file: string,
    args: string[]
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { timeout: 1000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(stdout?.toString() || "");
        }
      );
    });
  }

  private classifyProcessContext(
    context: ProcessContext,
    isIdle: boolean
  ): Pick<
    ProcessContext,
    "origin" | "launchTrigger" | "isSecurityProcess" | "originReason"
  > {
    const securityProcesses = new Set([
      "msmpeng.exe",
      "mssense.exe",
      "securityhealthservice.exe",
      "smartscreen.exe",
      "nissrv.exe",
    ]);
    const serviceParents = new Set(["services.exe", "svchost.exe"]);
    const scheduledTaskParents = new Set([
      "taskeng.exe",
      "taskhost.exe",
      "taskhostw.exe",
      "taskschd.exe",
    ]);
    const systemUsers = new Set([
      "system",
      "nt authority\\system",
      "local service",
      "nt authority\\local service",
      "network service",
      "nt authority\\network service",
    ]);

    const processName = (context.processName || "").toLowerCase();
    const pathName = context.executablePath
      ? path.basename(context.executablePath).toLowerCase()
      : "";
    const parentName = (context.parentName || "").toLowerCase();
    const user = (context.user || "").toLowerCase();
    const nameKey = pathName || processName;

    const isSecurityProcess = nameKey
      ? securityProcesses.has(nameKey)
      : false;

    let origin: ProcessOrigin = "user";
    let launchTrigger: LaunchTrigger = "unknown";
    let originReason = "no rule matched";

    if (isSecurityProcess) {
      origin = "security";
      launchTrigger = "service";
      originReason = "known security process";
    } else if (typeof context.sessionId === "number" && context.sessionId === 0) {
      origin = "system";
      launchTrigger = "service";
      originReason = "session 0 service";
    } else if (user && systemUsers.has(user)) {
      origin = "system";
      launchTrigger = "service";
      originReason = "service account";
    } else if (parentName && scheduledTaskParents.has(parentName)) {
      origin = "background";
      launchTrigger = "scheduled_task";
      originReason = "parent process is task scheduler";
    } else if (parentName && serviceParents.has(parentName)) {
      origin = "system";
      launchTrigger = "service";
      originReason = "parent process is service host";
    } else if (isIdle || context.detectionSource === "windows-fallback") {
      origin = "background";
      launchTrigger = "unknown";
      originReason = isIdle
        ? "system idle at capture time"
        : "fallback process detection";
    } else {
      origin = "user";
      launchTrigger = "user_action";
      originReason = "foreground window activity";
    }

    return {
      origin,
      launchTrigger,
      isSecurityProcess,
      originReason,
    };
  }
}
