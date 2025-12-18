import path from 'path';
import fs from 'fs';
import os from 'os';
import { nativeImage } from 'electron';
import { BaseEvent, ScreenshotData } from '../types/events';
import { logger } from './logger';

export interface ScreenshotterOptions {
  username: string;
  deviceId: string;
  domain: 'windows-desktop';
  minIntervalMs: number;
  minWindowChangeIntervalMs?: number; // Shorter interval specifically for window changes
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
  private readonly DEFAULT_WINDOW_CHANGE_INTERVAL_MS = 5000; // 5 seconds default for window changes

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
    const timeSinceLastShot = now - this.lastAt;
    // Use shorter interval for window changes to capture rapid window switches
    const minInterval = reason === 'window_change'
      ? (this.opts.minWindowChangeIntervalMs ?? this.DEFAULT_WINDOW_CHANGE_INTERVAL_MS)
      : this.opts.minIntervalMs;
    if (timeSinceLastShot < minInterval) {
      logger.log(`[tracker] Screenshot skipped: rate limited (${Math.round(timeSinceLastShot / 1000)}s since last, need ${minInterval / 1000}s)`);
      return;
    }
    this.lastAt = now;
    logger.log(`[tracker] Attempting screenshot capture (reason: ${reason})`);
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
      logger.log('[tracker] Attempting to load screenshot-desktop library...');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const screenshot = require('screenshot-desktop');
      logger.log('[tracker] screenshot-desktop library loaded successfully');
      
      // On macOS, try to specify screen index 0 (main display) to avoid capturing all screens combined
      // If screen option is not supported or fails, it will fall back to default behavior
      const screenshotOptions: { format: string; screen?: number } = { format: 'png' };
      if (process.platform === 'darwin') {
        // Try screen 0 (main display) first - this helps avoid capturing wrong screen
        screenshotOptions.screen = 0;
      }
      
      logger.log(`[tracker] Calling screenshot-desktop with options:`, screenshotOptions);
      const buf: Buffer = await screenshot(screenshotOptions);
      logger.log(`[tracker] screenshot-desktop returned buffer: ${buf ? buf.length : 0} bytes`);
      
      if (buf && buf.length > 0) {
        const img = nativeImage.createFromBuffer(buf);
        if (img.isEmpty()) {
          throw new Error('screenshot-desktop returned empty image');
        }
        const imgSize = img.getSize();
        logger.log(`[tracker] Screenshot captured: ${imgSize.width}x${imgSize.height}, ${buf.length} bytes`);
        dataUrl = img.toDataURL();
        if (!dataUrl || !dataUrl.startsWith('data:image')) {
          throw new Error('screenshot-desktop returned invalid image data');
        }
        logger.log(`[tracker] Screenshot converted to data URL: ${dataUrl.length} bytes`);
      } else {
        throw new Error('screenshot-desktop returned empty buffer');
      }
    } catch (err) {
      const errorMsg = (err as Error).message || String(err);
      const errorStack = (err as Error).stack || '';
      logger.error(`[tracker] screenshot-desktop failed: ${errorMsg}`);
      if (errorStack) {
        logger.error(`[tracker] screenshot-desktop error stack:`, errorStack);
      }
      
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
      logger.log('[tracker] Attempting screenshot fallback via renderer process (Windows/Linux)');
      try {
        const fallbackResult = await Promise.race([
          this.opts.requestCapture(reason),
          new Promise<string>((resolve) => {
            setTimeout(() => {
              logger.warn('[tracker] screenshot fallback timeout after 15 seconds');
              resolve('');
            }, 15000);
          })
        ]);
        
        if (!fallbackResult || fallbackResult === '') {
          logger.error('[tracker] screenshot fallback returned empty data URL - this might mean the window is not available or desktopCapturer failed');
          logger.error('[tracker] On Windows, ensure the app window is created and visible');
          return;
        }
        logger.log(`[tracker] screenshot fallback succeeded: ${fallbackResult.length} bytes`);
        dataUrl = fallbackResult;
      } catch (fallbackErr) {
        const fallbackErrorMsg = (fallbackErr as Error).message || String(fallbackErr);
        const fallbackErrorStack = (fallbackErr as Error).stack || '';
        logger.error('[tracker] screenshot fallback failed:', fallbackErrorMsg);
        if (fallbackErrorStack) {
          logger.error('[tracker] screenshot fallback error stack:', fallbackErrorStack);
        }
        return;
      }
    }
    if (!dataUrl || !dataUrl.startsWith('data:image')) {
      logger.error('[tracker] screenshot capture produced invalid data URL');
      return;
    }
    const pngBuffer = nativeImage.createFromDataURL(dataUrl).toPNG();
    const filename = path.join(SCREENSHOT_DIR, `shot-${now}.png`);
    fs.writeFileSync(filename, pngBuffer);
    logger.log(`[tracker] Screenshot saved locally: ${filename} (${pngBuffer.length} bytes)`);
    const data: ScreenshotData = { filename, reason };
    const event: BaseEvent = {
      username: this.opts.username,
      deviceId: this.opts.deviceId,
      domain: this.opts.domain,
      timestamp: new Date().toISOString(),
      type: 'screenshot',
      data
    };
    logger.log(`[tracker] Calling onShot handler to upload screenshot (reason: ${reason})`);
    this.onShot(event, dataUrl);
  }
}


