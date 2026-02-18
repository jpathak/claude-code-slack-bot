import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KanbanManager } from './kanban-manager.js';
import { ProjectConfig } from './project-config.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Mock the Slack App
function createMockApp() {
  return {
    client: {
      apiCall: vi.fn().mockRejectedValue(new Error('not_allowed')),
    },
  } as any;
}

/**
 * Each test gets its own unique temp directory so file-backed BoardStores
 * never collide between tests running in parallel.
 */
function createIsolatedProjectConfig(tmpDir: string) {
  const configPath = path.join(tmpDir, 'project-config.json');
  return new ProjectConfig(configPath);
}

describe('KanbanManager', () => {
  let app: any;
  let projectConfig: ProjectConfig;
  let manager: KanbanManager;
  let tmpDir: string;

  beforeEach(() => {
    // Create a unique temp dir for each test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
    app = createMockApp();
    projectConfig = createIsolatedProjectConfig(tmpDir);

    // Register a fake project mapping so getStore uses our isolated temp dir
    projectConfig.upsert({
      channelId: 'C123',
      channelName: 'proj-test',
      projectPath: path.join(tmpDir, 'project-c123'),
      projectName: 'test-project',
      listId: null,
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    });

    manager = new KanbanManager(app, projectConfig);
  });

  afterEach(() => {
    manager.dispose();
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('parseCommand', () => {
    it('should parse "board"', () => {
      expect(manager.parseCommand('board')).toEqual({ type: 'board' });
    });

    it('should parse "board" case-insensitive', () => {
      expect(manager.parseCommand('BOARD')).toEqual({ type: 'board' });
    });

    it('should parse "add task" with description', () => {
      expect(manager.parseCommand('add task implement auth')).toEqual({
        type: 'add',
        title: 'implement auth',
      });
    });

    it('should parse "Add Task" case-insensitive', () => {
      expect(manager.parseCommand('Add Task fix the login bug')).toEqual({
        type: 'add',
        title: 'fix the login bug',
      });
    });

    it('should parse "done" with ref', () => {
      expect(manager.parseCommand('done 1')).toEqual({
        type: 'done',
        ref: '1',
      });
    });

    it('should parse "done" with #ref', () => {
      expect(manager.parseCommand('done #3')).toEqual({
        type: 'done',
        ref: '#3',
      });
    });

    it('should parse "move" with ref and status', () => {
      expect(manager.parseCommand('move 1 in_progress')).toEqual({
        type: 'move',
        ref: '1',
        status: 'in_progress',
      });
    });

    it('should parse "move" with various statuses', () => {
      expect(manager.parseCommand('move 2 review')).toEqual({
        type: 'move',
        ref: '2',
        status: 'review',
      });
      expect(manager.parseCommand('move 3 planning')).toEqual({
        type: 'move',
        ref: '3',
        status: 'planning',
      });
      expect(manager.parseCommand('move 4 backlog')).toEqual({
        type: 'move',
        ref: '4',
        status: 'backlog',
      });
      expect(manager.parseCommand('move 5 clarification_needed')).toEqual({
        type: 'move',
        ref: '5',
        status: 'clarification_needed',
      });
    });

    it('should reject "move" with invalid status', () => {
      expect(manager.parseCommand('move 1 invalid')).toBeNull();
      expect(manager.parseCommand('move 1 testing')).toBeNull(); // removed status
    });

    it('should parse "sync"', () => {
      expect(manager.parseCommand('sync')).toEqual({ type: 'sync' });
    });

    it('should parse "sync projects"', () => {
      expect(manager.parseCommand('sync projects')).toEqual({ type: 'sync' });
    });

    it('should parse "go" command', () => {
      expect(manager.parseCommand('go 1')).toEqual({ type: 'go', ref: '1' });
      expect(manager.parseCommand('go #3')).toEqual({ type: 'go', ref: '#3' });
    });

    it('should parse "answer" command', () => {
      expect(manager.parseCommand('answer 1 yes do it')).toEqual({
        type: 'answer',
        ref: '1',
        response: 'yes do it',
      });
    });

    it('should parse "approve" command', () => {
      expect(manager.parseCommand('approve 2')).toEqual({ type: 'approve', ref: '2' });
    });

    it('should return null for unrecognized text', () => {
      expect(manager.parseCommand('help me with code')).toBeNull();
      expect(manager.parseCommand('')).toBeNull();
      expect(manager.parseCommand('add something')).toBeNull();
    });
  });

  describe('addItem', () => {
    it('should add an item with default backlog status', async () => {
      const item = await manager.addItem('C123', 'Fix bug');
      expect(item.title).toBe('Fix bug');
      expect(item.status).toBe('backlog');
      expect(item.source).toBe('user');
      expect(item.id).toBe('1');
    });

    it('should increment IDs', async () => {
      const item1 = await manager.addItem('C123', 'Task 1');
      const item2 = await manager.addItem('C123', 'Task 2');
      expect(item1.id).toBe('1');
      expect(item2.id).toBe('2');
    });

    it('should accept custom status and source', async () => {
      const item = await manager.addItem('C123', 'AI task', 'in_progress', 'claude');
      expect(item.status).toBe('in_progress');
      expect(item.source).toBe('claude');
    });
  });

  describe('updateItemStatus', () => {
    it('should update status by ID', async () => {
      await manager.addItem('C123', 'Task 1');
      const updated = await manager.updateItemStatus('C123', '1', 'in_progress');
      expect(updated?.status).toBe('in_progress');
    });

    it('should update status by #ID', async () => {
      await manager.addItem('C123', 'Task 1');
      const updated = await manager.updateItemStatus('C123', '#1', 'done');
      expect(updated?.status).toBe('done');
    });

    it('should return null for unknown ref', async () => {
      const updated = await manager.updateItemStatus('C123', '999', 'done');
      expect(updated).toBeNull();
    });

    it('should find by partial title match', async () => {
      await manager.addItem('C123', 'Fix the authentication bug');
      const updated = await manager.updateItemStatus('C123', 'authentication', 'done');
      expect(updated?.title).toBe('Fix the authentication bug');
      expect(updated?.status).toBe('done');
    });
  });

  describe('listItems', () => {
    it('should return empty array for new channel', () => {
      // Use a different channel that maps to a fresh temp dir
      projectConfig.upsert({
        channelId: 'C999',
        channelName: 'proj-other',
        projectPath: path.join(tmpDir, 'project-c999'),
        projectName: 'other',
        listId: null,
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });
      expect(manager.listItems('C999')).toEqual([]);
    });

    it('should return all items for a channel', async () => {
      await manager.addItem('C123', 'Task 1');
      await manager.addItem('C123', 'Task 2');
      expect(manager.listItems('C123')).toHaveLength(2);
    });

    it('should not mix items between channels', async () => {
      // Register a second channel mapping
      projectConfig.upsert({
        channelId: 'C456',
        channelName: 'proj-other',
        projectPath: path.join(tmpDir, 'project-c456'),
        projectName: 'other-project',
        listId: null,
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });

      await manager.addItem('C123', 'Task A');
      await manager.addItem('C456', 'Task B');
      expect(manager.listItems('C123')).toHaveLength(1);
      expect(manager.listItems('C456')).toHaveLength(1);
    });
  });

  describe('formatBoard', () => {
    it('should show empty state', () => {
      const board = manager.formatBoard([]);
      expect(board).toContain('No tasks yet');
      expect(board).toContain('add task');
    });

    it('should group items by status', async () => {
      await manager.addItem('C123', 'Backlog task');
      await manager.addItem('C123', 'In progress task', 'in_progress');
      await manager.addItem('C123', 'Done task', 'done');

      const items = manager.listItems('C123');
      const board = manager.formatBoard(items);

      expect(board).toContain('Backlog');
      expect(board).toContain('In Progress');
      expect(board).toContain('Done');
      expect(board).toContain('1/3');
    });

    it('should show source tags for claude items', async () => {
      await manager.addItem('C123', 'AI generated task', 'backlog', 'claude');
      const items = manager.listItems('C123');
      const board = manager.formatBoard(items);
      expect(board).toContain('`\u{1f916}`');
    });

    it('should show acceptance criteria count', async () => {
      const store = manager.getStore('C123');
      store.addItem({
        title: 'Task with AC',
        status: 'planning',
        source: 'claude',
        acceptanceCriteria: ['AC 1', 'AC 2'],
      });

      const items = manager.listItems('C123');
      const board = manager.formatBoard(items);
      expect(board).toContain('2 AC');
    });

    it('should show question count for clarification items', async () => {
      const store = manager.getStore('C123');
      store.addItem({
        title: 'Task with questions',
        status: 'clarification_needed',
        source: 'claude',
        questions: ['What framework?', 'What DB?'],
      });

      const items = manager.listItems('C123');
      const board = manager.formatBoard(items);
      expect(board).toContain('Clarification Needed');
      expect(board).toContain('\u{2753}2');
    });
  });

  describe('syncTodosToKanban', () => {
    it('should add new todos as kanban items', async () => {
      await manager.syncTodosToKanban('C123', [
        { id: '1', content: 'Fix bug', status: 'pending' },
        { id: '2', content: 'Add tests', status: 'in_progress' },
      ]);

      const items = manager.listItems('C123');
      expect(items).toHaveLength(2);
      expect(items[0].title).toBe('Fix bug');
      expect(items[0].status).toBe('backlog');
      expect(items[0].source).toBe('claude');
      expect(items[1].title).toBe('Add tests');
      expect(items[1].status).toBe('in_progress');
    });

    it('should map completed todos to review status (two-party validation)', async () => {
      await manager.syncTodosToKanban('C123', [
        { id: '1', content: 'Fix bug', status: 'completed' },
      ]);

      const items = manager.listItems('C123');
      expect(items[0].status).toBe('review');
    });

    it('should update existing items on re-sync', async () => {
      await manager.syncTodosToKanban('C123', [
        { id: '1', content: 'Fix bug', status: 'pending' },
      ]);

      await manager.syncTodosToKanban('C123', [
        { id: '1', content: 'Fix bug', status: 'in_progress' },
      ]);

      const items = manager.listItems('C123');
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('in_progress');
    });

    it('should not override done status on re-sync', async () => {
      await manager.syncTodosToKanban('C123', [
        { id: '1', content: 'Fix bug', status: 'pending' },
      ]);

      // User manually marks as done
      await manager.updateItemStatus('C123', '1', 'done');

      // Claude re-syncs with completed (normally maps to review)
      await manager.syncTodosToKanban('C123', [
        { id: '1', content: 'Fix bug', status: 'completed' },
      ]);

      const items = manager.listItems('C123');
      expect(items[0].status).toBe('done'); // Should stay done
    });
  });

  describe('checkListsAvailability', () => {
    it('should return false when API call fails', async () => {
      const available = await manager.checkListsAvailability();
      expect(available).toBe(false);
    });

    it('should cache the result', async () => {
      await manager.checkListsAvailability();
      await manager.checkListsAvailability();
      // Should only call API once
      expect(app.client.apiCall).toHaveBeenCalledTimes(1);
    });
  });
});
