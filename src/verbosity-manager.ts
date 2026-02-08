import { Logger } from './logger.js';
import { VerbosityLevel, VerbosityConfig } from './types.js';

export class VerbosityManager {
  private configs: Map<string, VerbosityConfig> = new Map();
  private logger = new Logger('VerbosityManager');
  private defaultLevel: VerbosityLevel;

  constructor(defaultLevel: VerbosityLevel = 'normal') {
    this.defaultLevel = defaultLevel;
  }

  /**
   * Generate a hierarchical key for storing verbosity settings.
   * Same key scheme as WorkingDirectoryManager:
   * Thread-specific > DM+User > Channel-wide
   */
  getConfigKey(channelId: string, threadTs?: string, userId?: string): string {
    if (threadTs) {
      return `${channelId}-${threadTs}`;
    }
    if (userId && channelId.startsWith('D')) {
      return `${channelId}-${userId}`;
    }
    return channelId;
  }

  /**
   * Set verbosity level for a channel/thread/DM
   */
  setVerbosity(
    channelId: string,
    level: VerbosityLevel,
    threadTs?: string,
    userId?: string
  ): void {
    const key = this.getConfigKey(channelId, threadTs, userId);
    this.configs.set(key, {
      channelId,
      threadTs,
      userId,
      level,
      setAt: new Date(),
    });
    this.logger.info('Verbosity level set', { key, level });
  }

  /**
   * Get verbosity level with fallback chain:
   * Thread > DM+User > Channel > default
   */
  getVerbosity(channelId: string, threadTs?: string, userId?: string): VerbosityLevel {
    // Check thread-specific
    if (threadTs) {
      const threadKey = this.getConfigKey(channelId, threadTs);
      const threadConfig = this.configs.get(threadKey);
      if (threadConfig) return threadConfig.level;
    }

    // Check channel/DM-specific
    const channelKey = this.getConfigKey(channelId, undefined, userId);
    const channelConfig = this.configs.get(channelKey);
    if (channelConfig) return channelConfig.level;

    return this.defaultLevel;
  }

  /**
   * Parse a verbosity set command from user text.
   * Returns the VerbosityLevel if text is a set command, null otherwise.
   *
   * Recognized commands:
   * - "verbose" -> verbose
   * - "quiet" or "minimal" -> minimal
   * - "normal" -> normal
   * - "verbosity minimal|normal|verbose" -> specified level
   */
  parseSetCommand(text: string): VerbosityLevel | null {
    const trimmed = text.trim().toLowerCase();

    if (/^verbose$/i.test(trimmed)) return 'verbose';
    if (/^(quiet|minimal)$/i.test(trimmed)) return 'minimal';
    if (/^normal$/i.test(trimmed)) return 'normal';

    const match = trimmed.match(/^verbosity\s+(minimal|normal|verbose)$/i);
    if (match) return match[1] as VerbosityLevel;

    return null;
  }

  /**
   * Check if text is a "get verbosity" query (bare "verbosity" with no args)
   */
  isGetCommand(text: string): boolean {
    return /^verbosity$/i.test(text.trim());
  }

  /**
   * Format a human-readable verbosity status message
   */
  formatVerbosityMessage(level: VerbosityLevel, context: string): string {
    const descriptions: Record<VerbosityLevel, string> = {
      minimal: 'Only final results and errors are shown. Status updated in-place.',
      normal: 'Intermediate text and a tool summary are shown at the end.',
      verbose: 'Everything is shown: each tool use, each text block, todo updates.',
    };
    return `Current verbosity for ${context}: *${level}*\n_${descriptions[level]}_\n\nSet with: \`quiet\` | \`normal\` | \`verbose\``;
  }
}
