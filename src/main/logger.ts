import fs from "fs";
import path from "path";
import os from "os";

const LOG_DIR = path.join(os.homedir(), ".windows-activity-tracker");
const LOG_FILE = path.join(LOG_DIR, "app.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB max log file size

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Write log message to both console and file
 */
function writeLog(level: string, message: string, ...args: any[]): void {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] [${level}] ${message}`;
  
  // Write to console
  if (level === "ERROR") {
    console.error(formattedMessage, ...args);
  } else {
    console.log(formattedMessage, ...args);
  }
  
  // Write to file
  try {
    // Check if log file is too large and rotate if needed
    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        // Rotate log file
        const backupFile = path.join(LOG_DIR, `app.${Date.now()}.log`);
        fs.renameSync(LOG_FILE, backupFile);
      }
    }
    
    // Append to log file
    const logLine = formattedMessage + (args.length > 0 ? " " + JSON.stringify(args) : "") + "\n";
    fs.appendFileSync(LOG_FILE, logLine, "utf-8");
  } catch (err) {
    // Don't crash if logging fails
    console.error("[logger] Failed to write to log file:", (err as Error).message);
  }
}

export const logger = {
  log: (message: string, ...args: any[]) => writeLog("INFO", message, ...args),
  error: (message: string, ...args: any[]) => writeLog("ERROR", message, ...args),
  warn: (message: string, ...args: any[]) => writeLog("WARN", message, ...args),
  debug: (message: string, ...args: any[]) => writeLog("DEBUG", message, ...args),
  getLogPath: () => LOG_FILE,
};

