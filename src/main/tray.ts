import { Menu, Tray, BrowserWindow, app, nativeImage } from "electron";
import path from "path";
import fs from "fs";

export interface TrayControllerOptions {
  onStart: () => void;
  onStop: () => void;
  onQuit: () => void;
  onShow: () => void;
  onHide: () => void;
  onCapture?: () => void;
  onToggleStartup?: () => void;
  isStartupEnabled?: () => boolean;
}

/**
 * Get the tray icon, trying multiple paths and fallbacks
 */
function getTrayIcon(): Electron.NativeImage {
  const isDev = !app.isPackaged;

  // Try to load icon from assets directory
  const possiblePaths = isDev
    ? [
        path.join(process.cwd(), "src", "assets", "image.png"),
        path.join(process.cwd(), "assets", "icon.png"),
        path.join(process.cwd(), "assets", "tray-icon.png"),
        path.join(process.cwd(), "src", "assets", "icon.png"),
        path.join(process.cwd(), "src", "assets", "tray-icon.png"),
      ]
    : [
        path.join(__dirname, "..", "assets", "image.png"),
        path.join(__dirname, "..", "assets", "icon.png"),
        path.join(__dirname, "..", "assets", "tray-icon.png"),
        path.join(app.getAppPath(), "assets", "image.png"),
        path.join(app.getAppPath(), "assets", "icon.png"),
        path.join(app.getAppPath(), "assets", "tray-icon.png"),
        path.join(app.getAppPath(), "dist", "assets", "image.png"),
        path.join(app.getAppPath(), "dist", "assets", "icon.png"),
      ];

  for (const iconPath of possiblePaths) {
    try {
      if (fs.existsSync(iconPath)) {
        const icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
          // Resize to appropriate size for system tray (16x16 or 32x32)
          const size = process.platform === "win32" ? 32 : 22;
          return icon.resize({ width: size, height: size });
        }
      }
    } catch (err) {
      // Continue to next path
    }
  }

  // Fallback: Try to use the app icon
  try {
    const appIcon = app.getAppPath();
    const iconPath = path.join(appIcon, "icon.png");
    if (fs.existsSync(iconPath)) {
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) {
        const size = process.platform === "win32" ? 32 : 22;
        return icon.resize({ width: size, height: size });
      }
    }
  } catch (err) {
    // Continue to programmatic fallback
  }

  // Final fallback: Create a simple programmatic icon
  // For Windows, create a 32x32 icon with a recognizable shape
  const size = process.platform === "win32" ? 32 : 22;
  const canvas = Buffer.alloc(size * size * 4);

  // Create a simple "A" shape on a blue background
  const centerX = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Blue background
      let r = 52;
      let g = 152;
      let b = 219;

      // Draw a simple "A" shape in white
      const isInA =
        y > size * 0.2 &&
        y < size * 0.8 &&
        (Math.abs(x - centerX) < size * 0.15 ||
          (y > size * 0.4 &&
            y < size * 0.6 &&
            Math.abs(x - centerX) < size * 0.25));

      if (isInA) {
        r = 255;
        g = 255;
        b = 255;
      }

      canvas[idx] = r; // R
      canvas[idx + 1] = g; // G
      canvas[idx + 2] = b; // B
      canvas[idx + 3] = 255; // A
    }
  }

  const icon = nativeImage.createFromBuffer(canvas, {
    width: size,
    height: size,
    scaleFactor: 1,
  });

  return icon;
}

export class TrayController {
  private tray: Tray | null = null;
  constructor(private readonly opts: TrayControllerOptions) {}

  init(window: BrowserWindow): void {
    if (this.tray) return;
    const icon = getTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip("Activity Tracker");
    this.updateMenu(window);
    this.tray.on("double-click", () => window.show());
  }

  updateMenu(window: BrowserWindow): void {
    if (!this.tray) return;

    const isStartup = this.opts.isStartupEnabled
      ? this.opts.isStartupEnabled()
      : false;
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Show",
        click: () => {
          window.show();
          this.opts.onShow();
        },
      },
      {
        label: "Hide",
        click: () => {
          window.hide();
          this.opts.onHide();
        },
      },
      { type: "separator" },
      ...(this.opts.onCapture
        ? ([
            { label: "Take Screenshot Now", click: this.opts.onCapture },
          ] as any)
        : []),
      ...(this.opts.onCapture ? ([{ type: "separator" }] as any) : []),
      { label: "Start Tracking", click: this.opts.onStart },
      { label: "Stop Tracking", click: this.opts.onStop },
      { type: "separator" },
      ...(this.opts.onToggleStartup
        ? ([
            {
              label: isStartup ? "✓ Start on Boot" : "Start on Boot",
              click: () => {
                this.opts.onToggleStartup?.();
                this.updateMenu(window); // Refresh menu to update checkmark
              },
            },
            { type: "separator" },
          ] as any)
        : []),
      { label: "Quit", click: this.opts.onQuit },
    ]);
    this.tray.setContextMenu(contextMenu);
  }
}
