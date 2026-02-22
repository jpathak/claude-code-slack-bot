import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskManager } from './task-manager.js';
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

describe('TaskManager', () => {
  let app: any;
  let projectConfig: ProjectConfig;
  let manager: TaskManager;
  let tmpDir: string;

  beforeEach(() => {
    // Create a unique temp dir for each test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-test-'));
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

    manager = new TaskManager(app, projectConfig);
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

  describe('syncTodosToTasks', () => {
    it('should add new todos as task items', async () => {
      await manager.syncTodosToTasks('C123', [
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
      await manager.syncTodosToTasks('C123', [
        { id: '1', content: 'Fix bug', status: 'completed' },
      ]);

      const items = manager.listItems('C123');
      expect(items[0].status).toBe('review');
    });

    it('should update existing items on re-sync', async () => {
      await manager.syncTodosToTasks('C123', [
        { id: '1', content: 'Fix bug', status: 'pending' },
      ]);

      await manager.syncTodosToTasks('C123', [
        { id: '1', content: 'Fix bug', status: 'in_progress' },
      ]);

      const items = manager.listItems('C123');
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('in_progress');
    });

    it('should not override done status on re-sync', async () => {
      await manager.syncTodosToTasks('C123', [
        { id: '1', content: 'Fix bug', status: 'pending' },
      ]);

      // User manually marks as done
      await manager.updateItemStatus('C123', '1', 'done');

      // Claude re-syncs with completed (normally maps to review)
      await manager.syncTodosToTasks('C123', [
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
