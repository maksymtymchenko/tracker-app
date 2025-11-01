import { Menu, Tray, BrowserWindow, app, nativeImage } from 'electron';

export interface TrayControllerOptions {
  onStart: () => void;
  onStop: () => void;
  onQuit: () => void;
  onShow: () => void;
  onHide: () => void;
  onCapture?: () => void;
}

export class TrayController {
  private tray: Tray | null = null;
  constructor(private readonly opts: TrayControllerOptions) {}

  init(window: BrowserWindow): void {
    if (this.tray) return;
    const icon = nativeImage.createEmpty();
    this.tray = new Tray(icon);
    this.tray.setToolTip('Activity Tracker');
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show', click: () => { window.show(); this.opts.onShow(); } },
      { label: 'Hide', click: () => { window.hide(); this.opts.onHide(); } },
      { type: 'separator' },
      ...(this.opts.onCapture ? [{ label: 'Take Screenshot Now', click: this.opts.onCapture }] as any : []),
      ...(this.opts.onCapture ? [{ type: 'separator' }] as any : []),
      { label: 'Start Tracking', click: this.opts.onStart },
      { label: 'Stop Tracking', click: this.opts.onStop },
      { type: 'separator' },
      { label: 'Quit', click: this.opts.onQuit }
    ]);
    this.tray.setContextMenu(contextMenu);
    this.tray.on('double-click', () => window.show());
  }
}


