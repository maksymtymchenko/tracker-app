import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';
import { app } from 'electron';
import { dialog } from 'electron';

const execAsync = promisify(exec);

/**
 * Information about a running process instance
 */
export interface ProcessInfo {
  pid: number;
  sessionId: number;
  username: string;
  imageName: string;
  windowTitle?: string;
}

/**
 * Result of process termination attempt
 */
export interface TerminationResult {
  success: boolean;
  processesTerminated: number;
  processesFound: number;
  errors: string[];
  requiresAdmin: boolean;
}

/**
 * Windows Process Manager for detecting and terminating processes across all user sessions
 * This is critical for per-user installations on multi-user Windows systems
 */
export class WindowsProcessManager {
  private readonly processName: string;
  private readonly executableName: string;

  constructor() {
    // Get the executable name from the app
    this.executableName = app.getName().replace(/\s+/g, '') + '.exe';
    // Also try with spaces (Windows Activity Tracker.exe)
    this.processName = app.getName() + '.exe';
  }

  /**
   * Detect all running instances of the application across all user sessions
   * Uses tasklist with verbose output to get session and user information
   */
  async detectAllProcesses(): Promise<ProcessInfo[]> {
    if (process.platform !== 'win32') {
      logger.warn('[process-manager] detectAllProcesses called on non-Windows platform');
      return [];
    }

    const processes: ProcessInfo[] = [];

    try {
      // Use tasklist with verbose output to get session ID and username
      // /V = verbose, /FO CSV = CSV format for easier parsing
      const command = `tasklist /V /FO CSV /FI "IMAGENAME eq ${this.processName}"`;
      
      logger.log(`[process-manager] Detecting processes: ${command}`);
      
      const { stdout, stderr } = await execAsync(command, {
        timeout: 10000, // 10 second timeout
        maxBuffer: 1024 * 1024, // 1MB buffer
      });

      if (stderr && !stderr.includes('INFO: No tasks')) {
        logger.warn(`[process-manager] tasklist stderr: ${stderr}`);
      }

      // Parse CSV output
      // Format: "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
      const lines = stdout.split('\n').filter(line => line.trim());
      
      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('INFO:')) continue;

        try {
          // Parse CSV line (handle quoted fields with commas)
          const fields = this.parseCSVLine(line);
          
          if (fields.length >= 7) {
            const imageName = fields[0]?.replace(/"/g, '') || '';
            const pid = parseInt(fields[1]?.replace(/"/g, '') || '0', 10);
            const sessionName = fields[2]?.replace(/"/g, '') || '';
            const sessionId = parseInt(fields[3]?.replace(/"/g, '') || '0', 10);
            const username = fields[6]?.replace(/"/g, '') || 'N/A';
            const windowTitle = fields.length >= 9 ? fields[8]?.replace(/"/g, '') : undefined;

            // Only include processes matching our executable name
            if (imageName === this.processName || imageName === this.executableName) {
              processes.push({
                pid,
                sessionId,
                username,
                imageName,
                windowTitle,
              });
            }
          }
        } catch (err) {
          logger.warn(`[process-manager] Failed to parse process line: ${line}`, (err as Error).message);
        }
      }

      // Also try with the executable name without spaces
      if (this.processName !== this.executableName) {
        try {
          const altCommand = `tasklist /V /FO CSV /FI "IMAGENAME eq ${this.executableName}"`;
          const { stdout: altStdout } = await execAsync(altCommand, {
            timeout: 10000,
            maxBuffer: 1024 * 1024,
          });

          const altLines = altStdout.split('\n').filter(line => line.trim());
          for (let i = 1; i < altLines.length; i++) {
            const line = altLines[i].trim();
            if (!line || line.startsWith('INFO:')) continue;

            try {
              const fields = this.parseCSVLine(line);
              if (fields.length >= 7) {
                const imageName = fields[0]?.replace(/"/g, '') || '';
                const pid = parseInt(fields[1]?.replace(/"/g, '') || '0', 10);
                const sessionId = parseInt(fields[3]?.replace(/"/g, '') || '0', 10);
                const username = fields[6]?.replace(/"/g, '') || 'N/A';
                const windowTitle = fields.length >= 9 ? fields[8]?.replace(/"/g, '') : undefined;

                if (imageName === this.executableName) {
                  // Check if we already have this PID
                  if (!processes.find(p => p.pid === pid)) {
                    processes.push({
                      pid,
                      sessionId,
                      username,
                      imageName,
                      windowTitle,
                    });
                  }
                }
              }
            } catch (err) {
              // Ignore parse errors for alternative name
            }
          }
        } catch (err) {
          // Ignore errors for alternative name check
        }
      }

      logger.log(`[process-manager] Found ${processes.length} process(es) across all sessions`);
      processes.forEach(p => {
        logger.log(`[process-manager]   - PID ${p.pid}, Session ${p.sessionId}, User: ${p.username}`);
      });

      return processes;
    } catch (err) {
      logger.error(`[process-manager] Error detecting processes:`, (err as Error).message);
      return [];
    }
  }

  /**
   * Parse a CSV line handling quoted fields that may contain commas
   */
  private parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote
          currentField += '"';
          i++; // Skip next quote
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // Field separator
        fields.push(currentField);
        currentField = '';
      } else {
        currentField += char;
      }
    }
    
    // Add last field
    if (currentField || fields.length > 0) {
      fields.push(currentField);
    }

    return fields;
  }

  /**
   * Terminate all instances of the application across all user sessions
   * Attempts graceful termination first, then force termination
   * Requires administrator privileges to terminate processes in other user sessions
   */
  async terminateAllProcesses(force: boolean = false): Promise<TerminationResult> {
    if (process.platform !== 'win32') {
      logger.warn('[process-manager] terminateAllProcesses called on non-Windows platform');
      return {
        success: false,
        processesTerminated: 0,
        processesFound: 0,
        errors: ['Not a Windows platform'],
        requiresAdmin: false,
      };
    }

    const processes = await this.detectAllProcesses();
    
    if (processes.length === 0) {
      logger.log('[process-manager] No processes found to terminate');
      return {
        success: true,
        processesTerminated: 0,
        processesFound: 0,
        errors: [],
        requiresAdmin: false,
      };
    }

    const errors: string[] = [];
    let terminatedCount = 0;
    let requiresAdmin = false;

    // Group processes by session
    const processesBySession = new Map<number, ProcessInfo[]>();
    processes.forEach(p => {
      if (!processesBySession.has(p.sessionId)) {
        processesBySession.set(p.sessionId, []);
      }
      processesBySession.get(p.sessionId)!.push(p);
    });

    logger.log(`[process-manager] Attempting to terminate ${processes.length} process(es) across ${processesBySession.size} session(s)`);

    // Get current username for comparison
    const currentUsername = (process.env.USERNAME || process.env.USER || '').toLowerCase();
    
    // Try to terminate all processes
    // Processes in current session will succeed, processes in other sessions may require admin
    for (const proc of processes) {
      const isCurrentUser = proc.username.toLowerCase() === currentUsername;
      
      try {
        // Try to terminate (will work for current session, may fail for other sessions)
        await this.terminateProcess(proc.pid, force, !isCurrentUser);
        terminatedCount++;
        logger.log(`[process-manager] Terminated process PID ${proc.pid} (Session ${proc.sessionId}, User: ${proc.username})`);
      } catch (err) {
        const errorMsg = (err as Error).message;
        
        // Check if error indicates admin privilege is needed
        if (errorMsg.includes('Access is denied') || 
            errorMsg.includes('permission') ||
            errorMsg.includes('privilege') ||
            errorMsg.includes('Administrator')) {
          requiresAdmin = true;
        }
        
        // Only add to errors if it's not a "process not found" error (which means it was already terminated)
        if (!errorMsg.includes('not found') && !errorMsg.includes('not running')) {
          errors.push(`PID ${proc.pid} (Session ${proc.sessionId}, User ${proc.username}): ${errorMsg}`);
          logger.error(`[process-manager] Failed to terminate PID ${proc.pid}:`, errorMsg);
        } else {
          // Process was already terminated, count as success
          terminatedCount++;
          logger.log(`[process-manager] Process PID ${proc.pid} already terminated`);
        }
      }
    }

    // Wait a moment for processes to fully terminate
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify termination
    const remainingProcesses = await this.detectAllProcesses();
    const allTerminated = remainingProcesses.length === 0;

    const result: TerminationResult = {
      success: allTerminated,
      processesTerminated: terminatedCount,
      processesFound: processes.length,
      errors,
      requiresAdmin,
    };

    if (allTerminated) {
      logger.log(`[process-manager] Successfully terminated all ${terminatedCount} process(es)`);
    } else {
      logger.warn(`[process-manager] Some processes remain: ${remainingProcesses.length} still running`);
    }

    return result;
  }

  /**
   * Terminate a specific process by PID
   */
  private async terminateProcess(pid: number, force: boolean, crossSession: boolean = false): Promise<void> {
    const forceFlag = force ? '/F' : '';
    const treeFlag = crossSession ? '/T' : ''; // /T terminates child processes
    
    // For cross-session termination, we need to use taskkill with admin privileges
    let command: string;
    
    if (crossSession) {
      // Use taskkill with /T to kill process tree, which works better across sessions
      command = `taskkill ${forceFlag} /T /PID ${pid}`;
    } else {
      command = `taskkill ${forceFlag} /PID ${pid}`;
    }

    logger.log(`[process-manager] Executing: ${command}`);

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: 5000,
      });

      if (stderr && !stderr.includes('SUCCESS')) {
        // Check if it's an access denied error
        if (stderr.includes('Access is denied') || stderr.includes('permission')) {
          throw new Error(`Access denied. Administrator privileges required to terminate process in another user session.`);
        }
        throw new Error(stderr);
      }

      logger.log(`[process-manager] Process ${pid} terminated: ${stdout}`);
    } catch (err: any) {
      // Check if process doesn't exist (already terminated)
      if (err.message && (
        err.message.includes('not found') ||
        err.message.includes('not running') ||
        err.code === 128 // Process not found exit code
      )) {
        logger.log(`[process-manager] Process ${pid} already terminated`);
        return;
      }
      throw err;
    }
  }

  /**
   * Get a user-friendly message describing which user sessions have running processes
   */
  async getProcessStatusMessage(): Promise<string> {
    const processes = await this.detectAllProcesses();
    
    if (processes.length === 0) {
      return 'No instances of the application are currently running.';
    }

    // Group by username
    const byUser = new Map<string, ProcessInfo[]>();
    processes.forEach(p => {
      if (!byUser.has(p.username)) {
        byUser.set(p.username, []);
      }
      byUser.get(p.username)!.push(p);
    });

    const currentUser = process.env.USERNAME || process.env.USER || 'current user';
    const parts: string[] = [];
    
    parts.push(`Found ${processes.length} instance(s) of the application running:`);
    
    const otherUserProcesses: ProcessInfo[] = [];
    
    for (const [username, userProcesses] of byUser.entries()) {
      const isCurrentUser = username.toLowerCase() === currentUser.toLowerCase();
      const userLabel = isCurrentUser ? `${username} (current session)` : username;
      parts.push(`  • ${userLabel}: ${userProcesses.length} process(es)`);
      
      if (!isCurrentUser) {
        otherUserProcesses.push(...userProcesses);
      }
    }

    if (byUser.size > 1) {
      parts.push('\n⚠️  Multi-user session detected:');
      parts.push(`The application is running in ${byUser.size} different user session(s).`);
      parts.push('\nTo update the application, all instances must be closed.');
      parts.push('\nOptions to close instances in other sessions:');
      parts.push('1. Run this application as Administrator (recommended)');
      parts.push('2. Sign out all other user sessions');
      parts.push('3. Use Task Manager with Administrator privileges to end processes');
      parts.push('4. Use the PowerShell helper script: scripts/terminate-processes.ps1');
    }

    return parts.join('\n');
  }
}

