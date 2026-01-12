import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface CrashInfo {
  timestamp: string;
  errorLog: string;
  exitCode?: number;
  signal?: string;
  analyzed: boolean;
}

export class CrashDetector {
  private logger = new Logger('CrashDetector');
  private crashStateFile: string;
  private errorLogPath: string;
  private lastStartupFile: string;

  constructor() {
    // Store crash state in the project directory
    const dataDir = join(__dirname, '..', '.crash-data');
    this.crashStateFile = join(dataDir, 'crash-state.json');
    this.lastStartupFile = join(dataDir, 'last-startup.txt');
    this.errorLogPath = process.env.ERROR_LOG_PATH ||
      '/Users/jpathak/Library/Logs/claude-code-slack.error.log';

    // Ensure data directory exists
    this.ensureDataDir(dataDir);
  }

  private ensureDataDir(dir: string): void {
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    } catch (e) {
      this.logger.warn('Failed to create crash data directory', { error: e });
    }
  }

  /**
   * Check if there was a crash since last successful startup
   */
  detectCrash(): CrashInfo | null {
    try {
      const lastStartup = this.getLastStartupTime();
      const errorLog = this.getRecentErrors(lastStartup);

      if (errorLog && errorLog.trim().length > 0) {
        const crashInfo: CrashInfo = {
          timestamp: new Date().toISOString(),
          errorLog: errorLog,
          analyzed: false,
        };

        this.logger.info('Detected crash from previous session', {
          errorLogLength: errorLog.length,
          lastStartup: lastStartup?.toISOString(),
        });

        return crashInfo;
      }

      return null;
    } catch (e) {
      this.logger.error('Error detecting crash', e);
      return null;
    }
  }

  /**
   * Get errors from the error log that occurred after last startup
   */
  private getRecentErrors(since: Date | null): string | null {
    try {
      if (!existsSync(this.errorLogPath)) {
        return null;
      }

      const stats = statSync(this.errorLogPath);

      // If file hasn't been modified since last startup, no new errors
      if (since && stats.mtime < since) {
        return null;
      }

      // Read the error log
      const content = readFileSync(this.errorLogPath, 'utf-8');

      // Return recent portion (last 5KB to avoid huge logs)
      const maxBytes = 5000;
      if (content.length > maxBytes) {
        return content.slice(-maxBytes);
      }

      return content.trim() || null;
    } catch (e) {
      this.logger.warn('Failed to read error log', { error: e });
      return null;
    }
  }

  /**
   * Get the timestamp of last successful startup
   */
  private getLastStartupTime(): Date | null {
    try {
      if (existsSync(this.lastStartupFile)) {
        const timestamp = readFileSync(this.lastStartupFile, 'utf-8').trim();
        return new Date(timestamp);
      }
    } catch (e) {
      // Ignore errors reading startup file
    }
    return null;
  }

  /**
   * Record current startup time
   */
  recordStartup(): void {
    try {
      writeFileSync(this.lastStartupFile, new Date().toISOString());
      this.logger.debug('Recorded startup time');
    } catch (e) {
      this.logger.warn('Failed to record startup time', { error: e });
    }
  }

  /**
   * Mark crash as analyzed (so we don't debug it again)
   */
  markCrashAnalyzed(crashInfo: CrashInfo): void {
    try {
      crashInfo.analyzed = true;
      writeFileSync(this.crashStateFile, JSON.stringify(crashInfo, null, 2));
      this.logger.info('Marked crash as analyzed');
    } catch (e) {
      this.logger.warn('Failed to mark crash as analyzed', { error: e });
    }
  }

  /**
   * Clear error log after processing
   */
  clearErrorLog(): void {
    try {
      if (existsSync(this.errorLogPath)) {
        writeFileSync(this.errorLogPath, '');
        this.logger.debug('Cleared error log');
      }
    } catch (e) {
      this.logger.warn('Failed to clear error log', { error: e });
    }
  }

  /**
   * Generate a self-debugging prompt for Claude
   */
  generateDebugPrompt(crashInfo: CrashInfo): string {
    return `🔧 **Self-Debugging Mode Activated**

The Slack bot crashed and has restarted. Please analyze the following error log and help debug the issue.

**Crash Timestamp:** ${crashInfo.timestamp}

**Error Log:**
\`\`\`
${crashInfo.errorLog.slice(0, 3000)}
\`\`\`

Please:
1. Identify the root cause of the crash
2. Suggest specific code fixes if applicable
3. Explain what triggered the error
4. Recommend any preventive measures

After analysis, I'll apply the necessary fixes to prevent this from happening again.`;
  }
}
