export type EventDomain = 'windows-desktop';

export interface BaseEvent {
  username: string;
  deviceId: string;
  domain: EventDomain;
  timestamp: string; // ISO string
  type: 'window_activity' | 'clipboard' | 'screenshot';
  durationMs?: number;
  reason?: string;
  data: unknown;
}

export interface WindowActivityData {
  application: string;
  title: string;
  duration: number;
  isIdle: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  path?: string;
}

export interface ClipboardData {
  content: string;
  length: number;
  type: 'url' | 'email' | 'number' | 'multiline_text' | 'text';
  application?: string;
  windowTitle?: string;
  url?: string;
}

export interface ScreenshotData {
  filename: string;
  reason: string;
}


