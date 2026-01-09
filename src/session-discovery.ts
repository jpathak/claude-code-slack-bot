import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { Logger } from './logger.js';

export interface SessionInfo {
  sessionId: string;
  workingDirectory: string;
  lastActivity: Date;
  messageCount: number;
  summary: string;  // First user message as summary
  filePath: string;
  owner?: 'cli' | 'slack';
  slackContext?: {
    channelId: string;
    threadTs?: string;
    userId: string;
  };
}

export interface SessionOwnership {
  sessionId: string;
  owner: 'cli' | 'slack';
  slackContext?: {
    channelId: string;
    threadTs?: string;
    userId: string;
  };
  lastModified: Date;
  lastModifiedBy: 'cli' | 'slack';
}

interface SessionMessage {
  type: string;
  message?: {
    role: string;
    content: string | any[];
  };
  timestamp?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
}

export class SessionDiscovery {
  private logger = new Logger('SessionDiscovery');
  private claudeDir: string;
  private projectsDir: string;
  private ownershipCache: Map<string, SessionOwnership> = new Map();

  constructor(homeDir?: string) {
    const home = homeDir || os.homedir();
    this.claudeDir = path.join(home, '.claude');
    this.projectsDir = path.join(this.claudeDir, 'projects');
  }

  /**
   * Encode a working directory path to match Claude CLI's format
   * Example: /Users/jpathak/workspace/project -> -Users-jpathak-workspace-project
   */
  encodeWorkingDirectory(workingDir: string): string {
    // Normalize the path first
    const normalized = path.resolve(workingDir);
    // Replace path separators with hyphens
    return normalized.replace(/\//g, '-');
  }

  /**
   * Decode an encoded path back to the original working directory
   */
  decodeWorkingDirectory(encoded: string): string {
    // Remove leading hyphen and replace remaining hyphens with slashes
    if (encoded.startsWith('-')) {
      return encoded.replace(/-/g, '/');
    }
    return '/' + encoded.replace(/-/g, '/');
  }

  /**
   * Get the session directory for a working directory
   */
  getSessionDirectory(workingDir: string): string {
    const encoded = this.encodeWorkingDirectory(workingDir);
    return path.join(this.projectsDir, encoded);
  }

  /**
   * List all sessions for a given working directory
   */
  async listSessions(workingDirectory: string): Promise<SessionInfo[]> {
    const sessionDir = this.getSessionDirectory(workingDirectory);

    this.logger.debug('Looking for sessions in', { sessionDir, workingDirectory });

    if (!fs.existsSync(sessionDir)) {
      this.logger.debug('Session directory does not exist', { sessionDir });
      return [];
    }

    const files = fs.readdirSync(sessionDir);
    const sessions: SessionInfo[] = [];

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;

      const filePath = path.join(sessionDir, file);
      const sessionId = file.replace('.jsonl', '');

      try {
        const sessionInfo = await this.parseSessionMetadata(filePath, sessionId, workingDirectory);
        if (sessionInfo) {
          // Load ownership info if available
          const ownership = this.getSessionOwnership(sessionId, workingDirectory);
          if (ownership) {
            sessionInfo.owner = ownership.owner;
            sessionInfo.slackContext = ownership.slackContext;
          }
          sessions.push(sessionInfo);
        }
      } catch (error) {
        this.logger.warn('Failed to parse session file', { file, error });
      }
    }

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());

    this.logger.debug('Found sessions', { count: sessions.length, workingDirectory });
    return sessions;
  }

  /**
   * Get the most recent session for a working directory
   */
  async getLatestSession(workingDirectory: string): Promise<SessionInfo | null> {
    const sessions = await this.listSessions(workingDirectory);
    return sessions.length > 0 ? sessions[0] : null;
  }

  /**
   * Get a specific session by ID
   */
  async getSessionById(sessionId: string, workingDirectory: string): Promise<SessionInfo | null> {
    const sessions = await this.listSessions(workingDirectory);
    return sessions.find(s => s.sessionId === sessionId || s.sessionId.startsWith(sessionId)) || null;
  }

  /**
   * Parse session metadata from a JSONL file
   */
  private async parseSessionMetadata(
    filePath: string,
    sessionId: string,
    workingDirectory: string
  ): Promise<SessionInfo | null> {
    return new Promise((resolve, reject) => {
      const stats = fs.statSync(filePath);
      let messageCount = 0;
      let firstUserMessage = '';
      let lastTimestamp: Date | null = null;

      const fileStream = fs.createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      rl.on('line', (line) => {
        try {
          const msg: SessionMessage = JSON.parse(line);

          // Count messages
          if (msg.type === 'user' || msg.type === 'assistant') {
            messageCount++;
          }

          // Get first user message as summary
          if (msg.type === 'user' && !firstUserMessage && msg.message?.content) {
            const content = msg.message.content;
            if (typeof content === 'string') {
              firstUserMessage = content.substring(0, 100);
            } else if (Array.isArray(content)) {
              const textPart = content.find((p: any) => p.type === 'text');
              if (textPart?.text) {
                firstUserMessage = textPart.text.substring(0, 100);
              }
            }
          }

          // Track last timestamp
          if (msg.timestamp) {
            const timestamp = new Date(msg.timestamp);
            if (!lastTimestamp || timestamp > lastTimestamp) {
              lastTimestamp = timestamp;
            }
          }
        } catch (parseError) {
          // Skip malformed lines
        }
      });

      rl.on('close', () => {
        // Use file modification time if no timestamp found in file
        const lastActivity = lastTimestamp || stats.mtime;

        resolve({
          sessionId,
          workingDirectory,
          lastActivity,
          messageCount,
          summary: firstUserMessage || '(no summary available)',
          filePath
        });
      });

      rl.on('error', (error) => {
        this.logger.error('Error reading session file', { filePath, error });
        resolve(null);
      });
    });
  }

  /**
   * Get the ownership file path for a working directory
   */
  private getOwnershipFilePath(workingDirectory: string): string {
    const sessionDir = this.getSessionDirectory(workingDirectory);
    return path.join(sessionDir, '.session-owners.json');
  }

  /**
   * Load session ownership data
   */
  private loadOwnershipData(workingDirectory: string): Record<string, SessionOwnership> {
    const filePath = this.getOwnershipFilePath(workingDirectory);

    if (!fs.existsSync(filePath)) {
      return {};
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Convert date strings back to Date objects
      for (const key in data) {
        if (data[key].lastModified) {
          data[key].lastModified = new Date(data[key].lastModified);
        }
      }

      return data;
    } catch (error) {
      this.logger.warn('Failed to load ownership data', { filePath, error });
      return {};
    }
  }

  /**
   * Save session ownership data
   */
  private saveOwnershipData(workingDirectory: string, data: Record<string, SessionOwnership>): void {
    const filePath = this.getOwnershipFilePath(workingDirectory);
    const sessionDir = this.getSessionDirectory(workingDirectory);

    // Ensure directory exists
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      this.logger.error('Failed to save ownership data', { filePath, error });
    }
  }

  /**
   * Get ownership info for a specific session
   */
  getSessionOwnership(sessionId: string, workingDirectory: string): SessionOwnership | undefined {
    const data = this.loadOwnershipData(workingDirectory);
    return data[sessionId];
  }

  /**
   * Set ownership for a session (called when Slack starts using it)
   */
  setSessionOwnership(
    sessionId: string,
    workingDirectory: string,
    slackContext: { channelId: string; threadTs?: string; userId: string }
  ): void {
    const data = this.loadOwnershipData(workingDirectory);

    data[sessionId] = {
      sessionId,
      owner: 'slack',
      slackContext,
      lastModified: new Date(),
      lastModifiedBy: 'slack'
    };

    this.saveOwnershipData(workingDirectory, data);
    this.ownershipCache.set(sessionId, data[sessionId]);

    this.logger.info('Set session ownership to Slack', { sessionId, slackContext });
  }

  /**
   * Clear ownership for a session (called when Slack releases it)
   */
  clearSessionOwnership(sessionId: string, workingDirectory: string): void {
    const data = this.loadOwnershipData(workingDirectory);
    delete data[sessionId];
    this.saveOwnershipData(workingDirectory, data);
    this.ownershipCache.delete(sessionId);

    this.logger.info('Cleared session ownership', { sessionId });
  }

  /**
   * Check if a session file was modified externally (by CLI)
   */
  async checkForExternalModification(
    sessionId: string,
    workingDirectory: string,
    lastKnownModTime: Date
  ): Promise<boolean> {
    const sessionDir = this.getSessionDirectory(workingDirectory);
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);

    if (!fs.existsSync(filePath)) {
      return false;
    }

    const stats = fs.statSync(filePath);
    return stats.mtime > lastKnownModTime;
  }

  /**
   * Get file modification time for a session
   */
  getSessionFileModTime(sessionId: string, workingDirectory: string): Date | null {
    const sessionDir = this.getSessionDirectory(workingDirectory);
    const filePath = path.join(sessionDir, `${sessionId}.jsonl`);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const stats = fs.statSync(filePath);
    return stats.mtime;
  }

  /**
   * Format session info for display in Slack
   */
  formatSessionForSlack(session: SessionInfo): string {
    const timeAgo = this.formatTimeAgo(session.lastActivity);
    const summary = session.summary.length > 50
      ? session.summary.substring(0, 50) + '...'
      : session.summary;
    const shortId = session.sessionId.substring(0, 8);
    const ownerBadge = session.owner === 'slack' ? '📱' : session.owner === 'cli' ? '💻' : '';

    return `\`${shortId}\` ${ownerBadge} • ${timeAgo} • ${session.messageCount} msgs\n_"${summary}"_`;
  }

  /**
   * Format a date as a human-readable "time ago" string
   */
  private formatTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  }

  /**
   * Check if the Claude projects directory exists
   */
  isClaudeConfigured(): boolean {
    return fs.existsSync(this.projectsDir);
  }
}
