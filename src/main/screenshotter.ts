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
  constructor(private readonly opts: ScreenshotterOptions, private readonly onShot: ScreenshotHandler) {}

  async capture(reason: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastAt < this.opts.minIntervalMs) return;
    this.lastAt = now;
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    let dataUrl = '';
    // Preferred: capture via native module in main process
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const screenshot = require('screenshot-desktop');
      const buf: Buffer = await screenshot({ format: 'png' });
      dataUrl = nativeImage.createFromBuffer(buf).toDataURL();
    } catch {
      // Fallback: ask renderer (may require permissions)
      dataUrl = await this.opts.requestCapture(reason);
    }
    if (!dataUrl || !dataUrl.startsWith('data:image')) return;
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


