import path from 'path';
import fs from 'fs';
import os from 'os';
import { nativeImage, powerMonitor } from 'electron';
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
  private readonly MAX_DIMENSION = 1600; // Downscale large captures to reduce size
  private readonly JPEG_QUALITY = 80; // JPEG quality (0-100)
  private readonly MAX_LOCAL_SCREENSHOTS = 500; // Retain at most this many local files
  private readonly MAX_LOCAL_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private isSystemSleeping = false;
  private lastWakeTime = Date.now();

  constructor(private readonly opts: ScreenshotterOptions, private readonly onShot: ScreenshotHandler) {
    this.setupPowerMonitor();
  }

  /**
   * Setup power monitor to detect system sleep/wake events
   */
  private setupPowerMonitor(): void {
    try {
      // Detect when system goes to sleep
      powerMonitor.on('suspend', () => {
        this.isSystemSleeping = true;
        logger.log('[tracker] System sleep detected - pausing screenshots');
      });

      // Detect when system wakes up
      powerMonitor.on('resume', () => {
        this.isSystemSleeping = false;
        this.lastWakeTime = Date.now();
        logger.log('[tracker] System wake detected - resuming screenshots');
      });

      // On macOS, also check for display sleep
      if (process.platform === 'darwin') {
        powerMonitor.on('lock-screen', () => {
          this.isSystemSleeping = true;
          logger.log('[tracker] Screen locked - pausing screenshots');
        });

        powerMonitor.on('unlock-screen', () => {
          this.isSystemSleeping = false;
          this.lastWakeTime = Date.now();
          logger.log('[tracker] Screen unlocked - resuming screenshots');
        });
      }
    } catch (err) {
      logger.error('[tracker] Failed to setup power monitor:', (err as Error).message);
    }
  }

  /**
   * Downscale image if needed to reduce bandwidth.
   * Returns PNG data URL for upload (server/UI expects PNG) and JPEG buffer for local storage.
   */
  private optimizeImage(img: Electron.NativeImage): {
    dataUrl: string; // PNG format for upload compatibility
    buffer: Buffer; // JPEG format for local storage efficiency
  } {
    const size = img.getSize();
    const scale =
      Math.max(size.width, size.height) > this.MAX_DIMENSION
        ? this.MAX_DIMENSION / Math.max(size.width, size.height)
        : 1;
    const targetWidth = Math.max(1, Math.round(size.width * scale));
    const targetHeight = Math.max(1, Math.round(size.height * scale));
    const resized =
      scale < 1 ? img.resize({ width: targetWidth, height: targetHeight }) : img;
    // PNG data URL for upload (server/UI expects PNG format)
    const pngDataUrl = resized.toDataURL();
    // JPEG buffer for local storage (more efficient)
    const jpegBuffer = resized.toJPEG(this.JPEG_QUALITY);
    return { dataUrl: pngDataUrl, buffer: jpegBuffer };
  }

  /**
   * Cleanup old screenshots to avoid unbounded disk usage.
   */
  private pruneLocalScreenshots(): void {
    try {
      if (!fs.existsSync(SCREENSHOT_DIR)) return;
      const files = fs.readdirSync(SCREENSHOT_DIR).map((name) => {
        const full = path.join(SCREENSHOT_DIR, name);
        const stat = fs.statSync(full);
        return { full, mtime: stat.mtimeMs };
      });
      const now = Date.now();
      const fresh = files.filter(
        (f) => now - f.mtime <= this.MAX_LOCAL_AGE_MS
      );
      const sorted = fresh.sort((a, b) => b.mtime - a.mtime);
      const keep = sorted.slice(0, this.MAX_LOCAL_SCREENSHOTS);
      const keepSet = new Set(keep.map((f) => f.full));
      files
        .filter((f) => !keepSet.has(f.full))
        .forEach((f) => {
          try {
            fs.unlinkSync(f.full);
          } catch (err) {
            logger.error(
              '[tracker] Failed to delete old screenshot:',
              (err as Error).message
            );
          }
        });
    } catch (err) {
      logger.error(
        '[tracker] Error pruning local screenshots:',
        (err as Error).message
      );
    }
  }

  /**
   * Check if system is currently sleeping
   * Also checks if we just woke up (within last 2 seconds) to avoid immediate screenshots
   */
  private isSystemAsleep(): boolean {
    if (this.isSystemSleeping) {
      return true;
    }
    
    // Don't take screenshots immediately after wake (wait 2 seconds)
    const timeSinceWake = Date.now() - this.lastWakeTime;
    if (timeSinceWake < 2000) {
      return true;
    }
    
    return false;
  }

  /**
   * Detect if a screenshot is mostly black (indicating system sleep or display off)
   * Returns true if the image is mostly black/dark
   * 
   * Improved detection: Only filter if screenshot is genuinely black (very low brightness)
   * and has suspiciously small file size, or if it's completely black (100% dark).
   */
  private isBlackScreenshot(img: Electron.NativeImage, originalBufferSize?: number): boolean {
    try {
      const size = img.getSize();
      const width = size.width;
      const height = size.height;
      
      // If image is empty or invalid, don't filter (let it through for debugging)
      if (width === 0 || height === 0) {
        logger.warn('[tracker] Screenshot has zero dimensions - allowing through');
        return false;
      }
      
      // Resize to a smaller image for faster analysis (100x100 is enough to detect black screens)
      const analysisSize = 100;
      const scale = Math.min(analysisSize / width, analysisSize / height);
      const scaledWidth = Math.floor(width * scale);
      const scaledHeight = Math.floor(height * scale);
      
      // Create a resized copy for analysis
      const resized = img.resize({ width: scaledWidth, height: scaledHeight });
      
      // Get bitmap buffer (RGBA format)
      const buffer = resized.getBitmap();
      
      if (!buffer || buffer.length === 0) {
        // If we can't get bitmap, don't filter
        logger.warn('[tracker] Could not get bitmap buffer - allowing screenshot through');
        return false;
      }
      
      let darkPixelCount = 0;
      let veryDarkPixelCount = 0;
      const threshold = 30; // RGB threshold for "black" (0-255, lower = darker)
      const veryDarkThreshold = 10; // Very dark threshold (almost pure black)
      const totalPixels = scaledWidth * scaledHeight;
      
      // Check pixels in the resized image
      for (let i = 0; i < buffer.length; i += 4) {
        if (i + 2 >= buffer.length) break;
        
        const r = buffer[i];
        const g = buffer[i + 1];
        const b = buffer[i + 2];
        
        // Calculate brightness
        const brightness = (r + g + b) / 3;
        
        if (brightness < threshold) {
          darkPixelCount++;
        }
        if (brightness < veryDarkThreshold) {
          veryDarkPixelCount++;
        }
      }
      
      const darkRatio = darkPixelCount / totalPixels;
      const veryDarkRatio = veryDarkPixelCount / totalPixels;
      
      // Check file size - if it's suspiciously small, it might be a black screen
      // A normal 1680x1050 screenshot should be at least 50KB+ even when compressed
      const suspiciouslySmall: boolean = originalBufferSize !== undefined && originalBufferSize < 20000 && (width * height) > 1000000;
      
      // Only filter if:
      // 1. 100% of pixels are very dark (almost pure black) - definitely a black screen
      // 2. OR 95%+ dark AND file is suspiciously small - likely a black screen
      const isBlack = veryDarkRatio > 0.99 || (darkRatio > 0.95 && suspiciouslySmall);
      
      if (isBlack) {
        logger.log(
          `[tracker] Black screenshot detected: ${Math.round(darkRatio * 100)}% dark pixels, ` +
          `${Math.round(veryDarkRatio * 100)}% very dark pixels (${scaledWidth}x${scaledHeight} analysis), ` +
          `buffer size: ${originalBufferSize || 'unknown'} bytes`
        );
      } else if (darkRatio > 0.5) {
        // Log if mostly dark but not black enough to filter (for debugging)
        logger.log(
          `[tracker] Screenshot is ${Math.round(darkRatio * 100)}% dark but not black enough to filter - allowing through`
        );
      }
      
      return isBlack;
    } catch (err) {
      logger.error('[tracker] Error detecting black screenshot:', (err as Error).message);
      // On error, don't filter - allow the screenshot through
      return false;
    }
  }

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

  /**
   * Attempt to capture a screenshot. Returns true if a screenshot was taken and sent,
   * false if skipped (idle, rate limit, black screen, etc.) so the scheduler can avoid
   * counting skipped attempts toward rate limits and hourly caps.
   */
  async capture(reason: string, screenIndex?: number): Promise<boolean> {
    // Check if system is sleeping first
    if (this.isSystemAsleep()) {
      logger.log(`[tracker] Screenshot skipped: system is sleeping (reason: ${reason})`);
      return false;
    }

    const now = Date.now();
    const timeSinceLastShot = now - this.lastAt;
    // Use shorter interval for window changes to capture rapid window switches
    const minInterval = reason === 'window_change'
      ? (this.opts.minWindowChangeIntervalMs ?? this.DEFAULT_WINDOW_CHANGE_INTERVAL_MS)
      : this.opts.minIntervalMs;
    if (timeSinceLastShot < minInterval) {
      logger.log(`[tracker] Screenshot skipped: rate limited (${Math.round(timeSinceLastShot / 1000)}s since last, need ${minInterval / 1000}s)`);
      return false;
    }
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
        return false;
      }
    }
    
    let dataUrl = '';
    let optimizedBuffer: Buffer | null = null;
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
      if (typeof screenIndex === 'number') {
        screenshotOptions.screen = screenIndex;
      } else if (process.platform === 'darwin') {
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
        
        // Check if screenshot is black (system might be sleeping)
        // Pass buffer size for better detection
        if (this.isBlackScreenshot(img, buf.length)) {
          logger.log(`[tracker] Screenshot skipped: black screenshot detected (likely system sleep or display off)`);
          return false;
        }
        
        const optimized = this.optimizeImage(img);
        dataUrl = optimized.dataUrl;
        optimizedBuffer = optimized.buffer;
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
        return false;
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
          return false;
        }
        logger.log(`[tracker] screenshot fallback succeeded: ${fallbackResult.length} bytes`);
        
        // Check if fallback screenshot is black
        try {
          const fallbackImg = nativeImage.createFromDataURL(fallbackResult);
          if (!fallbackImg.isEmpty()) {
            // Estimate buffer size from data URL (approximate)
            const estimatedSize = Math.floor(fallbackResult.length * 0.75); // Base64 is ~33% larger
            if (this.isBlackScreenshot(fallbackImg, estimatedSize)) {
              logger.log(`[tracker] Screenshot skipped: black screenshot detected in fallback (likely system sleep or display off)`);
              return false;
            }
          }
        } catch (err) {
          logger.error('[tracker] Error checking fallback screenshot for black screen:', (err as Error).message);
          // Continue with screenshot if check fails
        }
        
        const fallbackImg = nativeImage.createFromDataURL(fallbackResult);
        const optimized = this.optimizeImage(fallbackImg);
        dataUrl = optimized.dataUrl;
        optimizedBuffer = optimized.buffer;
      } catch (fallbackErr) {
        const fallbackErrorMsg = (fallbackErr as Error).message || String(fallbackErr);
        const fallbackErrorStack = (fallbackErr as Error).stack || '';
        logger.error('[tracker] screenshot fallback failed:', fallbackErrorMsg);
        if (fallbackErrorStack) {
          logger.error('[tracker] screenshot fallback error stack:', fallbackErrorStack);
        }
        return false;
      }
    }
    if (!dataUrl || !dataUrl.startsWith('data:image')) {
      logger.error('[tracker] screenshot capture produced invalid data URL');
      return false;
    }
    const uploadImage = nativeImage.createFromDataURL(dataUrl);
    if (!optimizedBuffer) {
      optimizedBuffer = uploadImage.toJPEG(this.JPEG_QUALITY);
    }
    const filename = path.join(SCREENSHOT_DIR, `shot-${now}.jpg`);
    fs.writeFileSync(filename, optimizedBuffer);
    this.lastAt = now;
    logger.log(`[tracker] Screenshot saved locally: ${filename} (${optimizedBuffer.length} bytes)`);
    this.pruneLocalScreenshots();
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
    return true;
  }
}

