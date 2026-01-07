export type EventDomain = 'windows-desktop';

export interface BaseEvent {
  username: string;
  deviceId: string;
  domain: EventDomain;
  timestamp: string; // ISO string
  type: 'window_activity' | 'clipboard' | 'screenshot';
  sessionId?: number;
  sessionName?: string;
  durationMs?: number;
  reason?: string;
  data: unknown;
}

export type ProcessOrigin = 'user' | 'system' | 'security' | 'background';
export type LaunchTrigger =
  | 'user_action'
  | 'scheduled_task'
  | 'service'
  | 'unknown';
export type ProcessDetectionSource =
  | 'active-win'
  | 'windows-fallback'
  | 'mac-osa'
  | 'linux-fallback'
  | 'unknown';

export interface ProcessContext {
  pid?: number;
  ppid?: number;
  processName?: string;
  parentName?: string;
  sessionId?: number;
  sessionName?: string;
  user?: string;
  executablePath?: string;
  origin?: ProcessOrigin;
  launchTrigger?: LaunchTrigger;
  detectionSource?: ProcessDetectionSource;
  isSecurityProcess?: boolean;
  originReason?: string;
}

export interface WindowActivityData {
  application: string;
  title: string;
  duration: number;
  isIdle: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  path?: string;
  process?: ProcessContext;
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
