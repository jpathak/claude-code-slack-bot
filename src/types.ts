export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
  /** Whether this session was resumed from an existing CLI/Slack session */
  isResumed?: boolean;
  /** The source of the resumed session */
  resumedFrom?: 'cli' | 'slack';
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}