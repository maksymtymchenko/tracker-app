import path from 'path';
import fs from 'fs';
import os from 'os';
import { nativeImage } from 'electron';
import { BaseEvent, ScreenshotData } from '../types/events';

export interface ScreenshotterOptions {
  username: string;
  deviceId: string;
  domain: 'windows-desktop';
  minIntervalMs: number;
  requestCapture: (reason: string) => Promise<string>; // returns data URL
}

export type ScreenshotHandler = (event: BaseEvent, pngBase64: string) => void;

const SCREENSHOT_DIR = path.join(os.homedir(), '.windows-activity-tracker', 'screenshots');

export class Screenshotter {
  private lastAt = 0;
  private permissionChecked = false;
  private hasPermission: boolean | null = null;
  private lastPermissionCheck = 0;
  private readonly PERMISSION_CHECK_INTERVAL = 30000; // Check every 30 seconds

  constructor(private readonly opts: ScreenshotterOptions, private readonly onShot: ScreenshotHandler) {}

  /**
   * Check if Screen Recording permission is granted on macOS.
   * Uses a test capture to verify permission is actually working.
   */
  private async checkPermission(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return true; // No permission check needed on other platforms
    }

    const now = Date.now();
    // Cache permission status for a short time to avoid repeated checks
    if (this.hasPermission !== null && (now - this.lastPermissionCheck) < this.PERMISSION_CHECK_INTERVAL) {
      return this.hasPermission;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const screenshot = require('screenshot-desktop');
      
      // Try a quick test capture with minimal options
      // If this fails, permission is likely not granted
      const testBuf: Buffer = await screenshot({ format: 'png', screen: 0 });
      
      if (testBuf && testBuf.length > 100) {
        // Got a valid buffer (at least 100 bytes)
        const testImg = nativeImage.createFromBuffer(testBuf);
        if (!testImg.isEmpty()) {
          this.hasPermission = true;
          this.lastPermissionCheck = now;
          this.permissionChecked = true;
          console.log('[tracker] Screen Recording permission verified');
          return true;
        }
      }
      
      // Buffer too small or empty image suggests permission issue
      this.hasPermission = false;
      this.lastPermissionCheck = now;
      this.permissionChecked = true;
      console.log('[tracker] Screen Recording permission appears to be missing (test capture failed)');
      return false;
    } catch (err) {
      const errorMsg = (err as Error).message || String(err);
      // Common permission-related errors on macOS
      if (errorMsg.includes('permission') || 
          errorMsg.includes('denied') || 
          errorMsg.includes('access') ||
          errorMsg.includes('CGDisplayCreateImage') ||
          errorMsg.includes('cannot capture')) {
        this.hasPermission = false;
        this.lastPermissionCheck = now;
        this.permissionChecked = true;
        console.log(`[tracker] Screen Recording permission denied: ${errorMsg}`);
        return false;
      }
      
      // Other errors might be temporary, don't cache as false
      console.log(`[tracker] Permission check error (non-fatal): ${errorMsg}`);
      // Return true to allow retry, but don't cache
      return this.hasPermission ?? true;
    }
  }

  async capture(reason: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastAt < this.opts.minIntervalMs) return;
    this.lastAt = now;
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    
    // On macOS, check permission before attempting capture
    if (process.platform === 'darwin') {
      const hasPermission = await this.checkPermission();
      if (!hasPermission) {
        // Only log once per check interval to avoid spam
        if (!this.permissionChecked || (now - this.lastPermissionCheck) >= this.PERMISSION_CHECK_INTERVAL) {
          console.log('[tracker] Skipping screenshot: Screen Recording permission not granted');
          console.log('[tracker] Please grant permission in System Settings → Privacy & Security → Screen Recording');
        }
        return;
      }
    }
    
    let dataUrl = '';
    // Preferred: capture via native module in main process
    // Note: On macOS, screenshot-desktop requires Screen Recording permission
    // On macOS with multiple displays, it may capture all screens combined or need screen index
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const screenshot = require('screenshot-desktop');
      
      // On macOS, try to specify screen index 0 (main display) to avoid capturing all screens combined
      // If screen option is not supported or fails, it will fall back to default behavior
      const screenshotOptions: { format: string; screen?: number } = { format: 'png' };
      if (process.platform === 'darwin') {
        // Try screen 0 (main display) first - this helps avoid capturing wrong screen
        screenshotOptions.screen = 0;
      }
      
      const buf: Buffer = await screenshot(screenshotOptions);
      if (buf && buf.length > 0) {
        const img = nativeImage.createFromBuffer(buf);
        if (img.isEmpty()) {
          throw new Error('screenshot-desktop returned empty image');
        }
        const imgSize = img.getSize();
        console.log(`[tracker] Screenshot captured: ${imgSize.width}x${imgSize.height}, ${buf.length} bytes`);
        dataUrl = img.toDataURL();
        if (!dataUrl || !dataUrl.startsWith('data:image')) {
          throw new Error('screenshot-desktop returned invalid image data');
        }
      } else {
        throw new Error('screenshot-desktop returned empty buffer');
      }
    } catch (err) {
      const errorMsg = (err as Error).message || String(err);
      console.log(`[tracker] screenshot-desktop failed: ${errorMsg}`);
      
      // On macOS, don't use desktopCapturer fallback to avoid permission prompts
      // If we get here after permission check passed, it might be a different issue
      if (process.platform === 'darwin') {
        // Invalidate permission cache on error - might have been revoked
        if (errorMsg.includes('permission') || 
            errorMsg.includes('denied') || 
            errorMsg.includes('access') ||
            errorMsg.includes('CGDisplayCreateImage')) {
          this.hasPermission = false;
          this.lastPermissionCheck = Date.now();
          console.log('[tracker] Permission appears to have been revoked or denied');
        }
        console.log('[tracker] On macOS, ensure Screen Recording permission is granted in System Settings → Privacy & Security → Screen Recording');
        return;
      }
      // On other platforms, fallback is safe
      try {
        dataUrl = await this.opts.requestCapture(reason);
      } catch (fallbackErr) {
        console.log('[tracker] screenshot fallback failed:', (fallbackErr as Error).message);
        return;
      }
    }
    if (!dataUrl || !dataUrl.startsWith('data:image')) {
      console.log('[tracker] screenshot capture produced invalid data URL');
      return;
    }
    const pngBuffer = nativeImage.createFromDataURL(dataUrl).toPNG();
    const filename = path.join(SCREENSHOT_DIR, `shot-${now}.png`);
    fs.writeFileSync(filename, pngBuffer);
    const data: ScreenshotData = { filename, reason };
    const event: BaseEvent = {
      username: this.opts.username,
      deviceId: this.opts.deviceId,
      domain: this.opts.domain,
      timestamp: new Date().toISOString(),
      type: 'screenshot',
      data
    };
    this.onShot(event, dataUrl);
  }
}


