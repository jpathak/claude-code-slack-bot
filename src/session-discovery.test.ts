import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionDiscovery, SessionInfo } from './session-discovery.js';

describe('SessionDiscovery', () => {
  let sessionDiscovery: SessionDiscovery;
  let testDir: string;
  let projectsDir: string;

  beforeEach(() => {
    // Create a temp directory for testing
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-test-'));
    projectsDir = path.join(testDir, '.claude', 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });

    // Use dependency injection to set the home directory
    sessionDiscovery = new SessionDiscovery(testDir);
  });

  afterEach(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('encodeWorkingDirectory', () => {
    it('should encode forward slashes as hyphens', () => {
      const encoded = sessionDiscovery.encodeWorkingDirectory('/Users/test/project');
      expect(encoded).toBe('-Users-test-project');
    });

    it('should handle paths with multiple segments', () => {
      const encoded = sessionDiscovery.encodeWorkingDirectory('/home/user/workspace/my-project');
      expect(encoded).toBe('-home-user-workspace-my-project');
    });

    it('should normalize relative paths', () => {
      // This test depends on the current working directory
      const cwd = process.cwd();
      const encoded = sessionDiscovery.encodeWorkingDirectory('.');
      expect(encoded).toBe(cwd.replace(/\//g, '-'));
    });
  });

  describe('decodeWorkingDirectory', () => {
    it('should decode hyphens back to forward slashes', () => {
      const decoded = sessionDiscovery.decodeWorkingDirectory('-Users-test-project');
      expect(decoded).toBe('/Users/test/project');
    });

    it('should handle paths without leading hyphen', () => {
      const decoded = sessionDiscovery.decodeWorkingDirectory('Users-test-project');
      expect(decoded).toBe('/Users/test/project');
    });
  });

  describe('getSessionDirectory', () => {
    it('should return the correct path for a working directory', () => {
      const sessionDir = sessionDiscovery.getSessionDirectory('/Users/test/project');
      expect(sessionDir).toBe(path.join(projectsDir, '-Users-test-project'));
    });
  });

  describe('listSessions', () => {
    it('should return empty array when no sessions exist', async () => {
      const sessions = await sessionDiscovery.listSessions('/non/existent/path');
      expect(sessions).toEqual([]);
    });

    it('should list sessions from the correct directory', async () => {
      // Create a test session directory
      const workingDir = '/test/project';
      const encodedDir = sessionDiscovery.encodeWorkingDirectory(workingDir);
      const sessionDir = path.join(projectsDir, encodedDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      // Create a test session file
      const sessionId = 'test-session-123';
      const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
      const sessionData = [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Hello, Claude!' },
          timestamp: new Date().toISOString(),
          uuid: 'msg-1',
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'Hello!' },
          timestamp: new Date().toISOString(),
          uuid: 'msg-2',
        }),
      ].join('\n');
      fs.writeFileSync(sessionFile, sessionData);

      const sessions = await sessionDiscovery.listSessions(workingDir);

      expect(sessions.length).toBe(1);
      expect(sessions[0].sessionId).toBe(sessionId);
      expect(sessions[0].messageCount).toBe(2);
      expect(sessions[0].summary).toBe('Hello, Claude!');
    });

    it('should sort sessions by last activity (most recent first)', async () => {
      const workingDir = '/test/project';
      const encodedDir = sessionDiscovery.encodeWorkingDirectory(workingDir);
      const sessionDir = path.join(projectsDir, encodedDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      // Create two session files with different timestamps
      const oldDate = new Date('2024-01-01');
      const newDate = new Date('2024-06-01');

      const oldSession = path.join(sessionDir, 'old-session.jsonl');
      fs.writeFileSync(oldSession, JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Old message' },
        timestamp: oldDate.toISOString(),
      }));
      fs.utimesSync(oldSession, oldDate, oldDate);

      const newSession = path.join(sessionDir, 'new-session.jsonl');
      fs.writeFileSync(newSession, JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'New message' },
        timestamp: newDate.toISOString(),
      }));
      fs.utimesSync(newSession, newDate, newDate);

      const sessions = await sessionDiscovery.listSessions(workingDir);

      expect(sessions.length).toBe(2);
      expect(sessions[0].sessionId).toBe('new-session');
      expect(sessions[1].sessionId).toBe('old-session');
    });
  });

  describe('getLatestSession', () => {
    it('should return null when no sessions exist', async () => {
      const session = await sessionDiscovery.getLatestSession('/non/existent');
      expect(session).toBeNull();
    });

    it('should return the most recent session', async () => {
      const workingDir = '/test/project';
      const encodedDir = sessionDiscovery.encodeWorkingDirectory(workingDir);
      const sessionDir = path.join(projectsDir, encodedDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      // Create test sessions
      const oldSession = path.join(sessionDir, 'old.jsonl');
      const newSession = path.join(sessionDir, 'new.jsonl');

      fs.writeFileSync(oldSession, JSON.stringify({
        type: 'user',
        message: { content: 'Old' },
        timestamp: '2024-01-01T00:00:00Z',
      }));

      fs.writeFileSync(newSession, JSON.stringify({
        type: 'user',
        message: { content: 'New' },
        timestamp: '2024-06-01T00:00:00Z',
      }));

      const latest = await sessionDiscovery.getLatestSession(workingDir);

      expect(latest).not.toBeNull();
      expect(latest!.sessionId).toBe('new');
    });
  });

  describe('getSessionById', () => {
    it('should find session by full ID', async () => {
      const workingDir = '/test/project';
      const encodedDir = sessionDiscovery.encodeWorkingDirectory(workingDir);
      const sessionDir = path.join(projectsDir, encodedDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      const sessionId = 'abc123-def456-ghi789';
      fs.writeFileSync(
        path.join(sessionDir, `${sessionId}.jsonl`),
        JSON.stringify({ type: 'user', message: { content: 'Test' } })
      );

      const session = await sessionDiscovery.getSessionById(sessionId, workingDir);

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(sessionId);
    });

    it('should find session by partial ID prefix', async () => {
      const workingDir = '/test/project';
      const encodedDir = sessionDiscovery.encodeWorkingDirectory(workingDir);
      const sessionDir = path.join(projectsDir, encodedDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      const sessionId = 'abc123-def456-ghi789';
      fs.writeFileSync(
        path.join(sessionDir, `${sessionId}.jsonl`),
        JSON.stringify({ type: 'user', message: { content: 'Test' } })
      );

      const session = await sessionDiscovery.getSessionById('abc123', workingDir);

      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe(sessionId);
    });

    it('should return null for non-existent session ID', async () => {
      const session = await sessionDiscovery.getSessionById('nonexistent', '/test');
      expect(session).toBeNull();
    });
  });

  describe('session ownership', () => {
    it('should set and get session ownership', () => {
      const workingDir = '/test/project';
      const sessionId = 'test-session';
      const slackContext = {
        channelId: 'C123',
        threadTs: '123.456',
        userId: 'U123',
      };

      // Create the session directory
      const encodedDir = sessionDiscovery.encodeWorkingDirectory(workingDir);
      const sessionDir = path.join(projectsDir, encodedDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      sessionDiscovery.setSessionOwnership(sessionId, workingDir, slackContext);

      const ownership = sessionDiscovery.getSessionOwnership(sessionId, workingDir);

      expect(ownership).not.toBeUndefined();
      expect(ownership!.owner).toBe('slack');
      expect(ownership!.slackContext).toEqual(slackContext);
    });

    it('should clear session ownership', () => {
      const workingDir = '/test/project';
      const sessionId = 'test-session';
      const slackContext = {
        channelId: 'C123',
        userId: 'U123',
      };

      // Create the session directory
      const encodedDir = sessionDiscovery.encodeWorkingDirectory(workingDir);
      const sessionDir = path.join(projectsDir, encodedDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      sessionDiscovery.setSessionOwnership(sessionId, workingDir, slackContext);
      sessionDiscovery.clearSessionOwnership(sessionId, workingDir);

      const ownership = sessionDiscovery.getSessionOwnership(sessionId, workingDir);

      expect(ownership).toBeUndefined();
    });
  });

  describe('formatSessionForSlack', () => {
    it('should format session info correctly', () => {
      const session: SessionInfo = {
        sessionId: 'abc123-def456',
        workingDirectory: '/test/project',
        lastActivity: new Date(),
        messageCount: 5,
        summary: 'Help me fix a bug',
        filePath: '/path/to/session.jsonl',
      };

      const formatted = sessionDiscovery.formatSessionForSlack(session);

      expect(formatted).toContain('abc123');
      expect(formatted).toContain('5 msgs');
      expect(formatted).toContain('Help me fix a bug');
    });

    it('should truncate long summaries', () => {
      const session: SessionInfo = {
        sessionId: 'abc123',
        workingDirectory: '/test',
        lastActivity: new Date(),
        messageCount: 1,
        summary: 'This is a very long summary that should be truncated because it exceeds the maximum length limit',
        filePath: '/path/to/session.jsonl',
      };

      const formatted = sessionDiscovery.formatSessionForSlack(session);

      expect(formatted).toContain('...');
      expect(formatted.length).toBeLessThan(session.summary.length + 50); // Some overhead for formatting
    });

    it('should show correct owner badge', () => {
      const slackSession: SessionInfo = {
        sessionId: 'abc123',
        workingDirectory: '/test',
        lastActivity: new Date(),
        messageCount: 1,
        summary: 'Test',
        filePath: '/path',
        owner: 'slack',
      };

      const cliSession: SessionInfo = {
        ...slackSession,
        owner: 'cli',
      };

      expect(sessionDiscovery.formatSessionForSlack(slackSession)).toContain('📱');
      expect(sessionDiscovery.formatSessionForSlack(cliSession)).toContain('💻');
    });
  });

  describe('isClaudeConfigured', () => {
    it('should return true when projects directory exists', () => {
      expect(sessionDiscovery.isClaudeConfigured()).toBe(true);
    });

    it('should return false when projects directory does not exist', () => {
      // Remove the projects directory
      fs.rmSync(projectsDir, { recursive: true });
      expect(sessionDiscovery.isClaudeConfigured()).toBe(false);
    });
  });

  describe('checkForExternalModification', () => {
    it('should detect when a file was modified after a given time', async () => {
      const workingDir = '/test/project';
      const sessionId = 'test-session';
      const encodedDir = sessionDiscovery.encodeWorkingDirectory(workingDir);
      const sessionDir = path.join(projectsDir, encodedDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, 'initial content');

      // Get the initial mod time
      const initialModTime = new Date(Date.now() - 10000); // 10 seconds ago

      // Modify the file
      fs.writeFileSync(sessionFile, 'modified content');

      const wasModified = await sessionDiscovery.checkForExternalModification(
        sessionId,
        workingDir,
        initialModTime
      );

      expect(wasModified).toBe(true);
    });

    it('should return false when file was not modified', async () => {
      const workingDir = '/test/project';
      const sessionId = 'test-session';
      const encodedDir = sessionDiscovery.encodeWorkingDirectory(workingDir);
      const sessionDir = path.join(projectsDir, encodedDir);
      fs.mkdirSync(sessionDir, { recursive: true });

      const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, 'content');

      // Wait a bit and get current time as the "last known" time
      await new Promise(resolve => setTimeout(resolve, 100));
      const futureTime = new Date(Date.now() + 10000); // 10 seconds in future

      const wasModified = await sessionDiscovery.checkForExternalModification(
        sessionId,
        workingDir,
        futureTime
      );

      expect(wasModified).toBe(false);
    });
  });
});
