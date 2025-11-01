## Windows Activity Tracker (Electron + TypeScript)

Cross-platform desktop activity tracker per `spec.md`.

### Scripts

- `npm run dev`: TypeScript watch + start Electron
- `npm run build`: Compile TypeScript to `dist`
- `npm start`: Run Electron using built output
- `npm run dist`: Build for all platforms
- `npm run dist:win`: Build Windows executable (.exe)

### Setup

1. Install Node.js 18+
2. `npm install`
3. `npm run dev`

Config written to `~/.windows-activity-tracker/config.json` on first run.

### Building Windows Executable

To create a Windows `.exe` file:

1. Install dependencies (if not already done):

   ```bash
   npm install
   ```

2. Build the executable:
   ```bash
   npm run dist:win
   ```

This creates two Windows outputs in the `release/` directory:

- **NSIS Installer**: `Windows Activity Tracker Setup 0.1.0.exe` - Full installer with options
- **Portable**: `Windows-Activity-Tracker-0.1.0-portable.exe` - Standalone executable (no installation needed)

**Note:** Building on macOS/Linux for Windows requires Wine (for NSIS). The portable build works cross-platform without Wine.

For testing, the portable `.exe` is recommended as it requires no installation.

### Multi-User Remote Desktop Deployment

The app automatically detects the current logged-in user for each event, making it suitable for shared remote desktops (Windows RDP, macOS screen sharing, etc.).

**How it works:**

- Each event includes the username of the user who triggered it (detected dynamically via `os.userInfo().username`).
- Events are tagged with the actual logged-in user, not a static hostname or config value.
- Supports per-user tracking when multiple users share the same remote desktop.

**Deployment options:**

1. **Per-User Installation (Recommended):**

   - Each user installs/runs the app in their own session.
   - Config stored in each user's home directory: `~/.windows-activity-tracker/config.json`.
   - Events automatically tagged with the correct username.

2. **System-Wide Installation:**
   - Install once for all users (e.g., in Program Files on Windows).
   - Each user gets their own config file in their home directory.
   - App detects the current user dynamically per event.

**Backend events include:**

- `username`: Actual logged-in user (detected at event time).
- `deviceId`: Unique identifier per installation.
- `domain`: "windows-desktop".
- `type`: "window_activity", "clipboard", or "screenshot".

This allows your backend to track activity per user on shared remote desktops.

### Notes

- Active window detection uses `active-win` on Windows/macOS/Linux when available.
  - macOS fallback: AppleScript
  - Windows/Linux fallback: best-effort via `systeminformation`
- Screenshots use `screenshot-desktop` (main process) or Electron `desktopCapturer` (fallback). Controlled via config and rate-limited.
- API endpoints:
  - POST `/collect-activity` with `{ events: ActivityEvent[] }`
  - POST `/collect-screenshot` with `{ deviceId, domain, username, screenshot }`
