import { Logger } from './logger.js';
import { SessionDiscovery } from './session-discovery.js';

interface WatchedSession {
  sessionId: string;
  workingDirectory: string;
  lastKnownModTime: Date;
  slackContext: {
    channelId: string;
    threadTs?: string;
    userId: string;
  };
}

interface HandoffCallback {
  (sessionId: string, slackContext: WatchedSession['slackContext']): Promise<void>;
}

export class SessionWatcher {
  private logger = new Logger('SessionWatcher');
  private sessionDiscovery: SessionDiscovery;
  private watchedSessions: Map<string, WatchedSession> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;
  private onHandoffCallback: HandoffCallback | null = null;

  constructor(sessionDiscovery: SessionDiscovery, pollIntervalMs: number = 30000) {
    this.sessionDiscovery = sessionDiscovery;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Start watching for session changes
   */
  start(): void {
    if (this.pollInterval) {
      this.logger.debug('Session watcher already running');
      return;
    }

    this.logger.info('Starting session watcher', { pollIntervalMs: this.pollIntervalMs });

    this.pollInterval = setInterval(() => {
      this.checkForExternalModifications();
    }, this.pollIntervalMs);
  }

  /**
   * Stop watching for session changes
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.logger.info('Session watcher stopped');
    }
  }

  /**
   * Set the callback to be invoked when a handoff is detected
   */
  onHandoff(callback: HandoffCallback): void {
    this.onHandoffCallback = callback;
  }

  /**
   * Register a session to watch for external modifications
   */
  watchSession(
    sessionId: string,
    workingDirectory: string,
    slackContext: WatchedSession['slackContext']
  ): void {
    const modTime = this.sessionDiscovery.getSessionFileModTime(sessionId, workingDirectory);

    if (!modTime) {
      this.logger.warn('Cannot watch session - file not found', { sessionId });
      return;
    }

    const watchedSession: WatchedSession = {
      sessionId,
      workingDirectory,
      lastKnownModTime: modTime,
      slackContext
    };

    this.watchedSessions.set(sessionId, watchedSession);

    this.logger.info('Started watching session', {
      sessionId,
      workingDirectory,
      slackContext
    });
  }

  /**
   * Stop watching a specific session
   */
  unwatchSession(sessionId: string): void {
    const wasWatching = this.watchedSessions.delete(sessionId);

    if (wasWatching) {
      this.logger.info('Stopped watching session', { sessionId });
    }
  }

  /**
   * Update the last known modification time for a session
   * (call this after Slack writes to the session)
   */
  updateModTime(sessionId: string): void {
    const watched = this.watchedSessions.get(sessionId);
    if (!watched) return;

    const modTime = this.sessionDiscovery.getSessionFileModTime(
      sessionId,
      watched.workingDirectory
    );

    if (modTime) {
      watched.lastKnownModTime = modTime;
      this.logger.debug('Updated session mod time', { sessionId, modTime });
    }
  }

  /**
   * Check all watched sessions for external modifications
   */
  private async checkForExternalModifications(): Promise<void> {
    const handoffs: Array<{ sessionId: string; slackContext: WatchedSession['slackContext'] }> = [];

    for (const [sessionId, watched] of this.watchedSessions) {
      try {
        const wasModified = await this.sessionDiscovery.checkForExternalModification(
          sessionId,
          watched.workingDirectory,
          watched.lastKnownModTime
        );

        if (wasModified) {
          this.logger.info('Detected external modification (CLI took over)', {
            sessionId,
            workingDirectory: watched.workingDirectory
          });

          handoffs.push({
            sessionId,
            slackContext: watched.slackContext
          });

          // Stop watching this session
          this.watchedSessions.delete(sessionId);

          // Clear Slack ownership
          this.sessionDiscovery.clearSessionOwnership(sessionId, watched.workingDirectory);
        }
      } catch (error) {
        this.logger.warn('Error checking session for modifications', { sessionId, error });
      }
    }

    // Notify about handoffs
    for (const { sessionId, slackContext } of handoffs) {
      if (this.onHandoffCallback) {
        try {
          await this.onHandoffCallback(sessionId, slackContext);
        } catch (error) {
          this.logger.error('Error in handoff callback', { sessionId, error });
        }
      }
    }
  }

  /**
   * Get the number of currently watched sessions
   */
  getWatchedSessionCount(): number {
    return this.watchedSessions.size;
  }

  /**
   * Check if a specific session is being watched
   */
  isWatching(sessionId: string): boolean {
    return this.watchedSessions.has(sessionId);
  }

  /**
   * Get all watched session IDs
   */
  getWatchedSessionIds(): string[] {
    return Array.from(this.watchedSessions.keys());
  }
}
