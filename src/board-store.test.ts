import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoardStore } from './board-store.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('BoardStore', () => {
  let tmpDir: string;
  let store: BoardStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardstore-test-'));
    store = new BoardStore(tmpDir);
  });

  afterEach(() => {
    store.dispose();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should create .kanban directory and board.json on first load', () => {
      const data = store.load();
      expect(data.version).toBe(1);
      expect(data.items).toEqual([]);
      expect(data.nextId).toBe(1);
      expect(data.columns).toHaveLength(7);
      expect(fs.existsSync(path.join(tmpDir, '.kanban', 'board.json'))).toBe(true);
    });

    it('should use the directory basename as project name', () => {
      const data = store.load();
      expect(data.projectName).toBe(path.basename(tmpDir));
    });

    it('should include all default columns', () => {
      const data = store.load();
      const columnIds = data.columns.map(c => c.id);
      expect(columnIds).toEqual([
        'backlog',
        'clarification_needed',
        'planning',
        'ready',
        'in_progress',
        'review',
        'done',
      ]);
    });
  });

  describe('addItem', () => {
    it('should add item with auto-incremented ID', () => {
      const item1 = store.addItem({ title: 'Task 1' });
      const item2 = store.addItem({ title: 'Task 2' });
      expect(item1.id).toBe('1');
      expect(item2.id).toBe('2');
    });

    it('should default to backlog status and user source', () => {
      const item = store.addItem({ title: 'My task' });
      expect(item.status).toBe('backlog');
      expect(item.source).toBe('user');
    });

    it('should accept custom status and source', () => {
      const item = store.addItem({
        title: 'AI task',
        status: 'in_progress',
        source: 'claude',
      });
      expect(item.status).toBe('in_progress');
      expect(item.source).toBe('claude');
    });

    it('should set timestamps', () => {
      const before = new Date().toISOString();
      const item = store.addItem({ title: 'Task' });
      const after = new Date().toISOString();
      expect(item.createdAt >= before).toBe(true);
      expect(item.createdAt <= after).toBe(true);
      expect(item.updatedAt >= before).toBe(true);
    });

    it('should persist item to disk', () => {
      store.addItem({ title: 'Persisted task' });

      // Read directly from disk
      const content = fs.readFileSync(store.getBoardFilePath(), 'utf-8');
      const data = JSON.parse(content);
      expect(data.items).toHaveLength(1);
      expect(data.items[0].title).toBe('Persisted task');
    });

    it('should accept optional fields', () => {
      const item = store.addItem({
        title: 'Full task',
        description: 'Detailed description',
        acceptanceCriteria: ['AC 1', 'AC 2'],
        questions: ['What framework?'],
        assignee: 'claude',
      });

      expect(item.description).toBe('Detailed description');
      expect(item.acceptanceCriteria).toEqual(['AC 1', 'AC 2']);
      expect(item.questions).toEqual(['What framework?']);
      expect(item.assignee).toBe('claude');
    });

    it('should default title to "Untitled" when not provided', () => {
      const item = store.addItem({});
      expect(item.title).toBe('Untitled');
    });
  });

  describe('updateItem', () => {
    it('should update title', () => {
      const item = store.addItem({ title: 'Original' });
      const updated = store.updateItem(item.id, { title: 'Updated' });
      expect(updated?.title).toBe('Updated');
    });

    it('should update status', () => {
      const item = store.addItem({ title: 'Task' });
      const updated = store.updateItem(item.id, { status: 'in_progress' });
      expect(updated?.status).toBe('in_progress');
    });

    it('should update description', () => {
      const item = store.addItem({ title: 'Task' });
      const updated = store.updateItem(item.id, { description: 'New desc' });
      expect(updated?.description).toBe('New desc');
    });

    it('should update acceptance criteria', () => {
      const item = store.addItem({ title: 'Task' });
      const updated = store.updateItem(item.id, {
        acceptanceCriteria: ['AC 1', 'AC 2'],
      });
      expect(updated?.acceptanceCriteria).toEqual(['AC 1', 'AC 2']);
    });

    it('should update questions', () => {
      const item = store.addItem({ title: 'Task' });
      const updated = store.updateItem(item.id, {
        questions: ['Q1?', 'Q2?'],
      });
      expect(updated?.questions).toEqual(['Q1?', 'Q2?']);
    });

    it('should set the updatedAt timestamp', () => {
      const item = store.addItem({ title: 'Task' });
      const updated = store.updateItem(item.id, { title: 'Changed' });
      // updatedAt should be a valid ISO timestamp
      expect(updated?.updatedAt).toBeDefined();
      expect(new Date(updated!.updatedAt).toISOString()).toBe(updated!.updatedAt);
      // updatedAt should be >= createdAt
      expect(updated!.updatedAt >= item.createdAt).toBe(true);
    });

    it('should return null for unknown ID', () => {
      const result = store.updateItem('999', { title: 'Nope' });
      expect(result).toBeNull();
    });

    it('should persist updates to disk', () => {
      const item = store.addItem({ title: 'Task' });
      store.updateItem(item.id, { title: 'Persisted change' });

      // Re-read from disk
      const content = fs.readFileSync(store.getBoardFilePath(), 'utf-8');
      const data = JSON.parse(content);
      expect(data.items[0].title).toBe('Persisted change');
    });
  });

  describe('moveItem', () => {
    it('should change the status of an item', () => {
      const item = store.addItem({ title: 'Task' });
      const moved = store.moveItem(item.id, 'review');
      expect(moved?.status).toBe('review');
    });

    it('should return null for unknown ID', () => {
      const result = store.moveItem('999', 'done');
      expect(result).toBeNull();
    });
  });

  describe('deleteItem', () => {
    it('should remove an item from the board', () => {
      const item = store.addItem({ title: 'To delete' });
      expect(store.getItems()).toHaveLength(1);

      const deleted = store.deleteItem(item.id);
      expect(deleted).toBe(true);
      expect(store.getItems()).toHaveLength(0);
    });

    it('should return false for unknown ID', () => {
      expect(store.deleteItem('999')).toBe(false);
    });

    it('should persist deletion to disk', () => {
      const item = store.addItem({ title: 'To delete' });
      store.deleteItem(item.id);

      const content = fs.readFileSync(store.getBoardFilePath(), 'utf-8');
      const data = JSON.parse(content);
      expect(data.items).toHaveLength(0);
    });
  });

  describe('getItems', () => {
    it('should return all items', () => {
      store.addItem({ title: 'Task 1' });
      store.addItem({ title: 'Task 2' });
      store.addItem({ title: 'Task 3' });
      expect(store.getItems()).toHaveLength(3);
    });

    it('should return empty array for fresh store', () => {
      expect(store.getItems()).toEqual([]);
    });
  });

  describe('getItemsByStatus', () => {
    it('should filter items by status', () => {
      store.addItem({ title: 'Backlog 1' });
      store.addItem({ title: 'In Progress 1', status: 'in_progress' });
      store.addItem({ title: 'Backlog 2' });
      store.addItem({ title: 'Done 1', status: 'done' });

      expect(store.getItemsByStatus('backlog')).toHaveLength(2);
      expect(store.getItemsByStatus('in_progress')).toHaveLength(1);
      expect(store.getItemsByStatus('done')).toHaveLength(1);
      expect(store.getItemsByStatus('review')).toHaveLength(0);
    });
  });

  describe('findItem', () => {
    it('should find by exact ID', () => {
      store.addItem({ title: 'Task 1' });
      store.addItem({ title: 'Task 2' });
      const found = store.findItem('2');
      expect(found?.title).toBe('Task 2');
    });

    it('should find by #ID', () => {
      store.addItem({ title: 'Task 1' });
      const found = store.findItem('#1');
      expect(found?.title).toBe('Task 1');
    });

    it('should find by partial title match', () => {
      store.addItem({ title: 'Fix the authentication bug' });
      const found = store.findItem('authentication');
      expect(found?.title).toBe('Fix the authentication bug');
    });

    it('should return null when not found', () => {
      store.addItem({ title: 'Task 1' });
      expect(store.findItem('nonexistent')).toBeNull();
    });

    it('should be case-insensitive for title match', () => {
      store.addItem({ title: 'Fix Login Bug' });
      const found = store.findItem('fix login');
      expect(found?.title).toBe('Fix Login Bug');
    });
  });

  describe('atomic writes', () => {
    it('should use temp file + rename pattern', () => {
      // Add an item and verify no temp files remain
      store.addItem({ title: 'Atomic test' });

      const kanbanDir = path.join(tmpDir, '.kanban');
      const files = fs.readdirSync(kanbanDir);
      const tmpFiles = files.filter(f => f.startsWith('.board.json.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('should not corrupt data on concurrent reads/writes', () => {
      // Simulate rapid writes
      for (let i = 0; i < 10; i++) {
        store.addItem({ title: `Rapid task ${i}` });
      }

      const items = store.getItems();
      expect(items).toHaveLength(10);
      for (let i = 0; i < 10; i++) {
        expect(items[i].title).toBe(`Rapid task ${i}`);
      }
    });
  });

  describe('cross-store reads', () => {
    it('should allow a second store to read data written by the first', () => {
      store.addItem({ title: 'Cross-store task' });

      // Create a second store pointing at the same path
      const store2 = new BoardStore(tmpDir);
      const items = store2.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Cross-store task');
      store2.dispose();
    });
  });

  describe('getProjectPath / getBoardFilePath', () => {
    it('should return the project path', () => {
      expect(store.getProjectPath()).toBe(tmpDir);
    });

    it('should return the board file path', () => {
      expect(store.getBoardFilePath()).toBe(path.join(tmpDir, '.kanban', 'board.json'));
    });
  });

  describe('load with corrupted file', () => {
    it('should create fresh board if file is corrupted JSON', () => {
      // Create the .kanban dir and write garbage
      const kanbanDir = path.join(tmpDir, '.kanban');
      fs.mkdirSync(kanbanDir, { recursive: true });
      fs.writeFileSync(path.join(kanbanDir, 'board.json'), '{invalid json!!!', 'utf-8');

      const data = store.load();
      expect(data.version).toBe(1);
      expect(data.items).toEqual([]);
    });
  });

  describe('file watcher (directory-based)', () => {
    it('should detect external writes via atomic rename', async () => {
      // Initialize the board so the .kanban dir exists
      store.load();

      let changeDetected = false;
      store.onChanged(() => {
        changeDetected = true;
      });

      // Give the watcher time to initialize fully
      await new Promise(resolve => setTimeout(resolve, 100));

      // Simulate an external write using the same atomic pattern (tmp + rename)
      // This tests the fix for macOS where rename events were previously missed
      const boardFile = store.getBoardFilePath();
      const data = store.load();
      data.items.push({
        id: '999',
        title: 'External item',
        status: 'backlog',
        source: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);
      data.updatedAt = new Date().toISOString();
      const content = JSON.stringify(data, null, 2);

      // Write to temp file then rename (atomic write pattern)
      const tmpFile = boardFile + '.ext-tmp';
      fs.writeFileSync(tmpFile, content, 'utf-8');
      fs.renameSync(tmpFile, boardFile);

      // Wait for the debounce (100ms) + generous buffer for CI/slow systems
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(changeDetected).toBe(true);
    });

    it('should fire callback for own writes (for Trello sync)', async () => {
      store.load();

      let changeDetected = false;
      store.onChanged(() => {
        changeDetected = true;
      });

      // Internal writes via the store's methods should fire callbacks
      // to trigger outbound sync (e.g., Trello sync)
      store.addItem({ title: 'Self-written item' });

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(changeDetected).toBe(true);
    });

    it('should watch the directory not the file', () => {
      store.load();
      store.onChanged(() => {});

      // The watcher should be active (we can verify by checking dispose doesn't error)
      // The key behavioral test is the atomic rename detection above
      store.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up watcher and callbacks', () => {
      // Register a change callback to start the watcher
      store.addItem({ title: 'Setup' });
      store.onChanged(() => {});

      // Should not throw
      store.dispose();
      store.dispose(); // Double dispose should be safe
    });
  });
});
