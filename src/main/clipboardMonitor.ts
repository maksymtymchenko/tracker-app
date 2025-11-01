import { clipboard } from 'electron';
import { BaseEvent, ClipboardData } from '../types/events';

export interface ClipboardMonitorOptions {
  username: string;
  deviceId: string;
  domain: 'windows-desktop';
  pollIntervalMs: number;
  maxLength: number;
}

export type ClipboardHandler = (event: BaseEvent) => void;

function inferType(content: string): ClipboardData['type'] {
  const urlRegex = /^(https?:\/\/|www\.)/i;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (urlRegex.test(content)) return 'url';
  if (emailRegex.test(content)) return 'email';
  if (!Number.isNaN(Number(content))) return 'number';
  if (content.includes('\n')) return 'multiline_text';
  return 'text';
}

export class ClipboardMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastText = '';
  constructor(private readonly opts: ClipboardMonitorOptions, private readonly onEvent: ClipboardHandler) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    try {
      const text = clipboard.readText();
      if (!text || text === this.lastText) return;
      this.lastText = text;
      const truncated = text.slice(0, this.opts.maxLength);
      const data: ClipboardData = {
        content: truncated,
        length: truncated.length,
        type: inferType(truncated)
      };
      const event: BaseEvent = {
        username: this.opts.username,
        deviceId: this.opts.deviceId,
        domain: this.opts.domain,
        timestamp: new Date().toISOString(),
        type: 'clipboard',
        reason: 'clipboard_copy',
        data
      };
      this.onEvent(event);
    } catch {
      // ignore
    }
  }
}


