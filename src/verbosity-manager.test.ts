import { describe, it, expect, beforeEach } from 'vitest';
import { VerbosityManager } from './verbosity-manager.js';
import { formatToolSummary, ToolActivityTracker } from './slack-handler.js';

describe('VerbosityManager', () => {
  let manager: VerbosityManager;

  beforeEach(() => {
    manager = new VerbosityManager('normal');
  });

  describe('constructor', () => {
    it('should use the provided default level', () => {
      const verboseManager = new VerbosityManager('verbose');
      expect(verboseManager.getVerbosity('C123')).toBe('verbose');
    });

    it('should default to normal when no level provided', () => {
      const defaultManager = new VerbosityManager();
      expect(defaultManager.getVerbosity('C123')).toBe('normal');
    });
  });

  describe('getConfigKey', () => {
    it('should return channelId for channel-level config', () => {
      expect(manager.getConfigKey('C123')).toBe('C123');
    });

    it('should return channelId-threadTs for thread-level config', () => {
      expect(manager.getConfigKey('C123', '1234567890.123456')).toBe('C123-1234567890.123456');
    });

    it('should return channelId-userId for DM-level config', () => {
      expect(manager.getConfigKey('D123', undefined, 'U456')).toBe('D123-U456');
    });

    it('should prefer thread key over DM key', () => {
      expect(manager.getConfigKey('D123', '1234567890.123456', 'U456')).toBe('D123-1234567890.123456');
    });

    it('should not include userId for non-DM channels', () => {
      expect(manager.getConfigKey('C123', undefined, 'U456')).toBe('C123');
    });
  });

  describe('setVerbosity and getVerbosity', () => {
    it('should set and get channel-level verbosity', () => {
      manager.setVerbosity('C123', 'verbose');
      expect(manager.getVerbosity('C123')).toBe('verbose');
    });

    it('should set and get thread-level verbosity', () => {
      manager.setVerbosity('C123', 'normal', '1234567890.123456');
      expect(manager.getVerbosity('C123', '1234567890.123456')).toBe('normal');
    });

    it('should set and get DM-level verbosity', () => {
      manager.setVerbosity('D123', 'verbose', undefined, 'U456');
      expect(manager.getVerbosity('D123', undefined, 'U456')).toBe('verbose');
    });

    it('should return default level when no config set', () => {
      expect(manager.getVerbosity('C999')).toBe('normal');
    });
  });

  describe('hierarchical fallback', () => {
    it('should fall back from thread to channel', () => {
      manager.setVerbosity('C123', 'verbose');
      // Thread has no explicit setting, should fall back to channel
      expect(manager.getVerbosity('C123', '1234567890.123456')).toBe('verbose');
    });

    it('should prefer thread-specific over channel-level', () => {
      manager.setVerbosity('C123', 'verbose');
      manager.setVerbosity('C123', 'minimal', '1234567890.123456');
      expect(manager.getVerbosity('C123', '1234567890.123456')).toBe('minimal');
    });

    it('should fall back from thread to DM+User', () => {
      manager.setVerbosity('D123', 'normal', undefined, 'U456');
      // Thread in DM with no explicit setting should fall back to DM+User
      expect(manager.getVerbosity('D123', '1234567890.123456', 'U456')).toBe('normal');
    });

    it('should prefer thread-specific over DM+User', () => {
      manager.setVerbosity('D123', 'normal', undefined, 'U456');
      manager.setVerbosity('D123', 'verbose', '1234567890.123456', 'U456');
      expect(manager.getVerbosity('D123', '1234567890.123456', 'U456')).toBe('verbose');
    });

    it('should fall back to default when no config matches', () => {
      const verboseDefault = new VerbosityManager('verbose');
      expect(verboseDefault.getVerbosity('C999', '1234567890.123456')).toBe('verbose');
    });
  });

  describe('parseSetCommand', () => {
    it('should parse "verbose"', () => {
      expect(manager.parseSetCommand('verbose')).toBe('verbose');
    });

    it('should parse "VERBOSE" (case-insensitive)', () => {
      expect(manager.parseSetCommand('VERBOSE')).toBe('verbose');
    });

    it('should parse "quiet"', () => {
      expect(manager.parseSetCommand('quiet')).toBe('minimal');
    });

    it('should parse "minimal"', () => {
      expect(manager.parseSetCommand('minimal')).toBe('minimal');
    });

    it('should parse "normal"', () => {
      expect(manager.parseSetCommand('normal')).toBe('normal');
    });

    it('should parse "verbosity minimal"', () => {
      expect(manager.parseSetCommand('verbosity minimal')).toBe('minimal');
    });

    it('should parse "verbosity normal"', () => {
      expect(manager.parseSetCommand('verbosity normal')).toBe('normal');
    });

    it('should parse "verbosity verbose"', () => {
      expect(manager.parseSetCommand('verbosity verbose')).toBe('verbose');
    });

    it('should handle whitespace', () => {
      expect(manager.parseSetCommand('  verbose  ')).toBe('verbose');
    });

    it('should return null for non-commands', () => {
      expect(manager.parseSetCommand('help me with code')).toBeNull();
    });

    it('should return null for partial matches', () => {
      expect(manager.parseSetCommand('verbose mode please')).toBeNull();
    });

    it('should return null for invalid verbosity levels', () => {
      expect(manager.parseSetCommand('verbosity loud')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(manager.parseSetCommand('')).toBeNull();
    });
  });

  describe('isGetCommand', () => {
    it('should return true for "verbosity"', () => {
      expect(manager.isGetCommand('verbosity')).toBe(true);
    });

    it('should return true for "VERBOSITY" (case-insensitive)', () => {
      expect(manager.isGetCommand('VERBOSITY')).toBe(true);
    });

    it('should handle whitespace', () => {
      expect(manager.isGetCommand('  verbosity  ')).toBe(true);
    });

    it('should return false for "verbosity minimal"', () => {
      expect(manager.isGetCommand('verbosity minimal')).toBe(false);
    });

    it('should return false for unrelated text', () => {
      expect(manager.isGetCommand('help')).toBe(false);
    });
  });

  describe('formatVerbosityMessage', () => {
    it('should include the level in bold', () => {
      const msg = manager.formatVerbosityMessage('minimal', 'this channel');
      expect(msg).toContain('*minimal*');
    });

    it('should include the context', () => {
      const msg = manager.formatVerbosityMessage('verbose', 'this thread');
      expect(msg).toContain('this thread');
    });

    it('should include command hints', () => {
      const msg = manager.formatVerbosityMessage('normal', 'this channel');
      expect(msg).toContain('quiet');
      expect(msg).toContain('normal');
      expect(msg).toContain('verbose');
    });

    it('should include description for minimal', () => {
      const msg = manager.formatVerbosityMessage('minimal', 'this channel');
      expect(msg).toContain('Only final results');
    });

    it('should include description for verbose', () => {
      const msg = manager.formatVerbosityMessage('verbose', 'this channel');
      expect(msg).toContain('Everything is shown');
    });
  });
});

describe('formatToolSummary', () => {
  function makeTracker(overrides: Partial<ToolActivityTracker> = {}): ToolActivityTracker {
    return {
      reads: 0,
      edits: 0,
      writes: 0,
      bashes: 0,
      others: 0,
      toolNames: new Set<string>(),
      ...overrides,
    };
  }

  it('should return "no tools used" when no activity', () => {
    expect(formatToolSummary(makeTracker())).toBe('no tools used');
  });

  it('should format a single read', () => {
    expect(formatToolSummary(makeTracker({ reads: 1 }))).toBe('Read 1 file');
  });

  it('should pluralize multiple reads', () => {
    expect(formatToolSummary(makeTracker({ reads: 3 }))).toBe('Read 3 files');
  });

  it('should format edits', () => {
    expect(formatToolSummary(makeTracker({ edits: 2 }))).toBe('edited 2 files');
  });

  it('should format writes', () => {
    expect(formatToolSummary(makeTracker({ writes: 1 }))).toBe('wrote 1 file');
  });

  it('should format bash commands', () => {
    expect(formatToolSummary(makeTracker({ bashes: 5 }))).toBe('ran 5 commands');
  });

  it('should format other tools', () => {
    expect(formatToolSummary(makeTracker({ others: 1 }))).toBe('used 1 other tool');
  });

  it('should combine multiple categories', () => {
    const summary = formatToolSummary(makeTracker({ reads: 3, edits: 1, bashes: 2 }));
    expect(summary).toBe('Read 3 files, edited 1 file, ran 2 commands');
  });

  it('should include all non-zero categories', () => {
    const summary = formatToolSummary(makeTracker({
      reads: 1, edits: 1, writes: 1, bashes: 1, others: 1,
    }));
    expect(summary).toContain('Read 1 file');
    expect(summary).toContain('edited 1 file');
    expect(summary).toContain('wrote 1 file');
    expect(summary).toContain('ran 1 command');
    expect(summary).toContain('used 1 other tool');
  });
});
