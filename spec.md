## Project Requirements (Windows Activity Tracker)

### 1. Goal

Build a lightweight desktop activity tracker that runs in the background, captures user activity signals (active window usage, clipboard events, screenshots), and sends structured telemetry to a server for analytics and review.

### 2. Core Logic

- Background service starts at app launch and minimizes to system tray.
- Periodically detect the active window and measure focused duration per window/app.
- Detect idle state when no foreground change for a configured interval.
- Optionally capture event-based screenshots (e.g., on window change) with rate limits.
- Monitor clipboard changes and emit typed metadata (no full-content storage beyond a safe limit).
- Buffer events in-memory and send in batches to reduce network overhead.
- Persist user and runtime configuration in the user home directory; allow live updates to reconfigure without restart.

### 3. Features

- Activity Tracking
  - Foreground window title, application name/path, focused duration, screen bounds
  - Idle detection with transitions (active ↔ idle)
- Clipboard Monitoring (configurable)
  - Detect content type (url, email, number, multiline_text, text)
  - Emit metadata (length, first N chars, inferred URL) with safety truncation
- Screenshots (configurable)
  - Trigger on window change; optional on click
  - Local file save to user directory; server notified with metadata and optional base64 upload
  - Rate limiting: min interval between screenshots; per-hour cap
- Buffering & Delivery
  - Event buffer with `batchSize` threshold and on-demand flush
  - Separate delayed batcher for screenshot uploads
- Tray & Lifecycle
  - Show/Hide main window, Start/Stop tracking, Quit
  - Close action hides to tray; app remains running
- Minimal UI
  - Display current username and basic status; no heavy controls
- Configuration
  - Stored at `~/.windows-activity-tracker/config.json`
  - Keys: username, serverUrl, trackingInterval, minActivityDuration, maxIdleTime, trackClipboard, trackScreenshots, screenshotOnWindowChange, screenshotOnClick, minScreenshotInterval, screenshotBatchDelay, batchSize, workApplications, personalApplications

### 4. Data Model (client-side events)

- Common fields
  - `username`, `deviceId`, `domain` (e.g., "windows-desktop"), `timestamp`, `type`, `durationMs?`, `reason?`, `data` (object)
- Window activity event
  - `type: "window_activity"`; `data`: { application, title, duration, isIdle, bounds, path }
- Clipboard event
  - `type: "clipboard"`; `reason: "clipboard_copy"`; `data`: { content (truncated), length, type, application, windowTitle, url }
- Screenshot event
  - `type: "screenshot"`; `data`: { filename, reason }

### 5. API Integration (server-side)

- Base URL: from config `serverUrl`
- Endpoints used
  - POST `/collect-activity`
    - Body: `{ events: ActivityEvent[] }`
    - Usage: send buffered activity (window, clipboard, screenshot metadata)
  - POST `/collect-screenshot`
    - Body: `{ deviceId, domain: 'windows-desktop', username, screenshot: 'data:image/png;base64,...' }`
    - Usage: create server-side screenshot record; typically after local capture
- Notes
  - Large request bodies supported by server; still prefer batching and sensible intervals
  - In production, consider multipart streaming for screenshots instead of base64 JSON

### 6. Tech Stack

- Desktop Runtime: Electron (Main + Renderer)
- Language: Node.js (CommonJS), minimal browser JS in renderer
- OS Support: Windows (primary), macOS (active-window + screenshots via AppleScript), Linux (GNOME screenshot fallback)
- System Info: `systeminformation` for process data fallback
- HTTP: `axios` for API calls
- Storage: File system (config and local screenshots)

### 7. Performance & Limits

- Configurable `trackingInterval` (default ~10s) for activity polling
- `minActivityDuration` before an activity is recorded
- `minScreenshotInterval` and `maxScreenshotsPerHour` to control image volume
- `batchSize` for event buffering; `screenshotBatchDelay` for screenshot send coalescing

### 8. Privacy & Security

- Clipboard content truncated to a safe maximum (e.g., 1000 chars)
- Screenshots stored locally; sending controlled by configuration
- Server communication over HTTPS when configured; avoid PII beyond configured fields
- Session/auth handled server-side; client only provides username for attribution

### 9. Error Handling & Resilience

- Network failures: keep buffers, retry on next cycle
- Guarded access to OS features (clipboard, screenshots) with clear logs on failure
- Graceful shutdown: flush buffers before exit

### 10. Non-Goals (current scope)

- Full keystroke logging
- Continuous video capture
- Deep OS-level hooks requiring privileged drivers

### 11. Deliverables

- Electron app with background tracking and tray integration
- Config file generation and updates
- Event delivery to server endpoints
- Basic README and this spec documenting logic, features, and stack
