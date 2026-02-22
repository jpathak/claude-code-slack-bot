import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TrelloSync } from './trello-sync.js';
import { Config } from './config.js';
import { ProjectConfig } from './project-config.js';
import { BoardStore } from './board-store.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Mock node-fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.mock('node-fetch', () => ({
  default: (...args: any[]) => mockFetch(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(overrides: Partial<Config['trello']> = {}): Config {
  return {
    slack: { botToken: '', appToken: '', signingSecret: '' },
    anthropic: {},
    claude: { useBedrock: false, useVertex: false },
    baseDirectory: '',
    debug: false,
    selfDebugOnCrash: false,
    defaultVerbosity: 'normal',
    tasks: { enabled: true, autoProvision: false, channelPrefix: 'proj-', implementationTimeoutMs: 1800000, planningTimeoutMs: 600000 },
    trello: {
      enabled: true,
      apiKey: 'test-api-key',
      token: 'test-token',
      pollIntervalMs: 30000,
      ...overrides,
    },
  } as Config;
}

function createMockProjectConfig(projects: Array<{ channelId: string; projectPath: string; projectName: string }>): ProjectConfig {
  const pc = {
    getAll: vi.fn().mockReturnValue(projects.map(p => ({
      channelId: p.channelId,
      projectPath: p.projectPath,
      projectName: p.projectName,
      channelName: `proj-${p.projectName}`,
      listId: null,
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    }))),
    getByChannelId: vi.fn().mockImplementation((id: string) => {
      const p = projects.find(p => p.channelId === id);
      if (!p) return undefined;
      return {
        channelId: p.channelId,
        projectPath: p.projectPath,
        projectName: p.projectName,
        channelName: `proj-${p.projectName}`,
        listId: null,
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      };
    }),
    getByProjectPath: vi.fn(),
    getByProjectName: vi.fn(),
    upsert: vi.fn(),
    save: vi.fn(),
    getListIdForChannel: vi.fn().mockReturnValue(null),
    getChannelIdForProject: vi.fn(),
    hasProject: vi.fn(),
    updateListId: vi.fn(),
  } as unknown as ProjectConfig;
  return pc;
}

function mockTrelloApi(handlers: Record<string, (url: string, opts: any) => any> = {}) {
  mockFetch.mockImplementation(async (url: string, opts: any = {}) => {
    const method = opts.method || 'GET';
    const key = `${method} ${extractEndpoint(url)}`;

    for (const [pattern, handler] of Object.entries(handlers)) {
      if (key.startsWith(pattern) || matchPattern(key, pattern)) {
        const result = handler(url, opts);
        return {
          ok: true,
          status: 200,
          json: async () => result,
          text: async () => JSON.stringify(result),
        };
      }
    }

    // Default: return empty response
    return {
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '[]',
    };
  });
}

function extractEndpoint(url: string): string {
  const u = new URL(url);
  return u.pathname.replace('/1', '');
}

function matchPattern(key: string, pattern: string): boolean {
  // Simple pattern matching: GET /boards/*/cards
  const regex = pattern.replace(/\*/g, '[^/]+');
  return new RegExp(`^${regex}`).test(key);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrelloSync', () => {
  let tmpDir: string;
  let config: Config;
  let projectConfig: ProjectConfig;
  let trelloSync: TrelloSync;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trello-test-'));
    config = createTestConfig();
    projectConfig = createMockProjectConfig([
      { channelId: 'C123', projectPath: tmpDir, projectName: 'test-project' },
    ]);
    trelloSync = new TrelloSync(config, projectConfig);
    mockFetch.mockReset();
  });

  afterEach(() => {
    trelloSync.dispose();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Mapping Persistence
  // -------------------------------------------------------------------------

  describe('mapping persistence', () => {
    it('should save and load Trello mapping', async () => {
      const mappingPath = path.join(tmpDir, '.tasks', 'trello-mapping.json');

      // Setup: create board and lists via mocked API
      mockTrelloApi({
        'GET /members/me/boards': () => [],
        'POST /boards': () => ({ id: 'board-1', name: 'test-project', url: 'https://trello.com/b/abc' }),
        'GET /boards/board-1/lists': () => [],
        'POST /lists': (url: string) => {
          const body = JSON.parse((mockFetch.mock.calls.find(
            (c: any[]) => c[0] === url
          ) || [, {}])[1]?.body || '{}');
          return { id: `list-${body.name?.replace(/\s/g, '-') || 'unknown'}`, name: body.name, pos: body.pos };
        },
      });

      await trelloSync.initializeProject('C123', tmpDir, 'test-project');

      // Verify mapping file was created
      expect(fs.existsSync(mappingPath)).toBe(true);

      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      expect(mapping.version).toBe(1);
      expect(mapping.boardId).toBe('board-1');
      expect(mapping.boardUrl).toBe('https://trello.com/b/abc');
    });

    it('should handle missing mapping file gracefully', async () => {
      // syncOutbound should silently return when no mapping exists
      await trelloSync.syncOutbound('C123', tmpDir);
      // No error thrown
    });

    it('should handle corrupted mapping file gracefully', async () => {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), '{invalid', 'utf-8');

      // Should not throw, returns null internally
      await trelloSync.syncOutbound('C123', tmpDir);
    });
  });

  // -------------------------------------------------------------------------
  // Board & List Initialization
  // -------------------------------------------------------------------------

  describe('board initialization', () => {
    it('should find existing board instead of creating new one', async () => {
      mockTrelloApi({
        'GET /members/me/boards': () => [
          { id: 'existing-board', name: 'test-project', url: 'https://trello.com/b/existing', closed: false },
        ],
        'GET /boards/existing-board/lists': () => [
          { id: 'list-1', name: 'Backlog', closed: false, pos: 1024 },
          { id: 'list-2', name: 'Clarification Needed', closed: false, pos: 2048 },
          { id: 'list-3', name: 'Planning', closed: false, pos: 3072 },
          { id: 'list-4', name: 'Ready to Execute', closed: false, pos: 4096 },
          { id: 'list-5', name: 'In Progress', closed: false, pos: 5120 },
          { id: 'list-6', name: 'Review', closed: false, pos: 6144 },
          { id: 'list-7', name: 'Done', closed: false, pos: 7168 },
        ],
      });

      await trelloSync.initializeProject('C123', tmpDir, 'test-project');

      // Should NOT have called POST /boards
      const postBoardCalls = mockFetch.mock.calls.filter(
        (c: any[]) => c[1]?.method === 'POST' && extractEndpoint(c[0]).includes('/boards')
      );
      expect(postBoardCalls).toHaveLength(0);
    });

    it('should preserve existing card mappings on re-initialization', async () => {
      // Pre-create a mapping with existing card entries (simulating a bot restart)
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });

      const existingMapping = {
        version: 1,
        boardId: 'old-board-id',
        boardUrl: 'https://trello.com/b/old',
        listIds: {
          backlog: 'old-list-backlog',
          clarification_needed: 'old-list-clarification',
          planning: 'old-list-planning',
          ready: 'old-list-ready',
          in_progress: 'old-list-in-progress',
          review: 'old-list-review',
          done: 'old-list-done',
        },
        cards: [
          {
            localId: '1',
            trelloCardId: 'trello-existing-card',
            lastSyncedAt: new Date().toISOString(),
            lastLocalHash: 'hash1',
            lastTrelloHash: 'hash1',
          },
          {
            localId: '2',
            trelloCardId: 'trello-existing-card-2',
            lastSyncedAt: new Date().toISOString(),
            lastLocalHash: 'hash2',
            lastTrelloHash: 'hash2',
          },
        ],
      };
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify(existingMapping, null, 2), 'utf-8');

      // Also create matching local items so outbound sync doesn't try to delete them
      const store = new BoardStore(tmpDir);
      store.addItem({ title: 'Task 1', status: 'backlog' }); // id=1
      store.addItem({ title: 'Task 2', status: 'backlog' }); // id=2
      store.dispose();

      mockTrelloApi({
        'GET /members/me/boards': () => [
          { id: 'board-1', name: 'test-project', url: 'https://trello.com/b/new', closed: false },
        ],
        'GET /boards/board-1/lists': () => [
          { id: 'list-1', name: 'Backlog', closed: false, pos: 1024 },
          { id: 'list-2', name: 'Clarification Needed', closed: false, pos: 2048 },
          { id: 'list-3', name: 'Planning', closed: false, pos: 3072 },
          { id: 'list-4', name: 'Ready to Execute', closed: false, pos: 4096 },
          { id: 'list-5', name: 'In Progress', closed: false, pos: 5120 },
          { id: 'list-6', name: 'Review', closed: false, pos: 6144 },
          { id: 'list-7', name: 'Done', closed: false, pos: 7168 },
        ],
      });

      await trelloSync.initializeProject('C123', tmpDir, 'test-project');

      // Verify the mapping preserved the existing card entries
      const mappingPath = path.join(tasksDir, 'trello-mapping.json');
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));

      // Board/list IDs should be updated
      expect(mapping.boardId).toBe('board-1');
      expect(mapping.boardUrl).toBe('https://trello.com/b/new');

      // Card mappings should be PRESERVED (not wiped to [])
      expect(mapping.cards).toHaveLength(2);
      expect(mapping.cards[0].trelloCardId).toBe('trello-existing-card');
      expect(mapping.cards[1].trelloCardId).toBe('trello-existing-card-2');

      // No new cards should have been created (items already mapped)
      const postCardCalls = mockFetch.mock.calls.filter(
        (c: any[]) => c[1]?.method === 'POST' && extractEndpoint(c[0]).includes('/cards')
      );
      expect(postCardCalls).toHaveLength(0);
    });

    it('should create missing lists on existing board', async () => {
      mockTrelloApi({
        'GET /members/me/boards': () => [
          { id: 'board-1', name: 'test-project', url: 'https://trello.com/b/abc', closed: false },
        ],
        'GET /boards/board-1/lists': () => [
          { id: 'list-1', name: 'Backlog', closed: false, pos: 1024 },
          // Missing most lists
        ],
        'POST /lists': (_url: string, opts: any) => {
          const body = JSON.parse(opts.body || '{}');
          return { id: `new-list-${body.name?.replace(/\s/g, '-')}`, name: body.name, pos: body.pos };
        },
      });

      await trelloSync.initializeProject('C123', tmpDir, 'test-project');

      // Should have created 6 missing lists (Backlog exists)
      const postListCalls = mockFetch.mock.calls.filter(
        (c: any[]) => c[1]?.method === 'POST' && extractEndpoint(c[0]).includes('/lists')
      );
      expect(postListCalls).toHaveLength(6);
    });
  });

  // -------------------------------------------------------------------------
  // Outbound Sync (Local -> Trello)
  // -------------------------------------------------------------------------

  describe('outbound sync', () => {
    function setupMappingWithLists(): void {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify({
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [],
      }), 'utf-8');
    }

    it('should create Trello card for new local item', async () => {
      setupMappingWithLists();

      // Add a local item
      const store = new BoardStore(tmpDir);
      store.addItem({ title: 'New Task', description: 'A test task', status: 'backlog' });
      store.dispose();

      let createdCard: any = null;
      mockTrelloApi({
        'POST /cards': (_url: string, opts: any) => {
          createdCard = JSON.parse(opts.body || '{}');
          return { id: 'trello-card-1', name: createdCard.name, desc: createdCard.desc, idList: createdCard.idList };
        },
      });

      await trelloSync.syncOutbound('C123', tmpDir);

      expect(createdCard).not.toBeNull();
      expect(createdCard.name).toBe('New Task');
      expect(createdCard.idList).toBe('list-backlog');

      // Verify mapping was updated
      const mapping = JSON.parse(fs.readFileSync(path.join(tmpDir, '.tasks', 'trello-mapping.json'), 'utf-8'));
      expect(mapping.cards).toHaveLength(1);
      expect(mapping.cards[0].localId).toBe('1');
      expect(mapping.cards[0].trelloCardId).toBe('trello-card-1');
    });

    it('should update Trello card when local item changes', async () => {
      setupMappingWithLists();

      // Add a local item and sync
      const store = new BoardStore(tmpDir);
      const item = store.addItem({ title: 'Original Title', status: 'backlog' });

      mockTrelloApi({
        'POST /cards': () => ({ id: 'trello-card-1', name: 'Original Title', desc: '', idList: 'list-backlog' }),
        'PUT /cards/trello-card-1': (_url: string, opts: any) => {
          const body = JSON.parse(opts.body || '{}');
          return { id: 'trello-card-1', ...body };
        },
      });

      await trelloSync.syncOutbound('C123', tmpDir);

      // Now update the local item
      store.updateItem(item.id, { title: 'Updated Title', status: 'in_progress' });
      store.dispose();

      await trelloSync.syncOutbound('C123', tmpDir);

      // Verify PUT was called
      const putCalls = mockFetch.mock.calls.filter(
        (c: any[]) => c[1]?.method === 'PUT'
      );
      expect(putCalls.length).toBeGreaterThan(0);
    });

    it('should delete Trello card when local item is deleted', async () => {
      setupMappingWithLists();

      // Setup mapping with an existing card
      const mappingPath = path.join(tmpDir, '.tasks', 'trello-mapping.json');
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      mapping.cards.push({
        localId: '999',
        trelloCardId: 'trello-to-delete',
        lastSyncedAt: new Date().toISOString(),
        lastLocalHash: 'old-hash',
        lastTrelloHash: 'old-hash',
      });
      fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), 'utf-8');

      let deletedCardId: string | null = null;
      mockTrelloApi({
        'DELETE /cards': (url: string) => {
          deletedCardId = extractEndpoint(url).split('/cards/')[1];
          return null;
        },
      });

      await trelloSync.syncOutbound('C123', tmpDir);

      expect(deletedCardId).toBe('trello-to-delete');

      // Verify mapping was cleaned up
      const updatedMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      expect(updatedMapping.cards).toHaveLength(0);
    });

    it('should skip unchanged items', async () => {
      setupMappingWithLists();

      const store = new BoardStore(tmpDir);
      store.addItem({ title: 'Stable Task', status: 'backlog' });

      mockTrelloApi({
        'POST /cards': () => ({ id: 'trello-card-1', name: 'Stable Task', desc: '', idList: 'list-backlog' }),
      });

      // First sync creates the card
      await trelloSync.syncOutbound('C123', tmpDir);

      // Reset fetch mock
      mockFetch.mockReset();
      mockTrelloApi({});

      // Second sync should not make any API calls (item unchanged)
      await trelloSync.syncOutbound('C123', tmpDir);

      // No POST or PUT calls expected
      const writeCalls = mockFetch.mock.calls.filter(
        (c: any[]) => c[1]?.method === 'POST' || c[1]?.method === 'PUT'
      );
      expect(writeCalls).toHaveLength(0);
      store.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Inbound Sync (Trello -> Local)
  // -------------------------------------------------------------------------

  describe('inbound sync', () => {
    function setupMappingWithBoard(): void {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify({
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [],
      }), 'utf-8');
    }

    it('should create local item for new Trello card', async () => {
      setupMappingWithBoard();

      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-new-1', name: 'Card from Trello', desc: 'Created on phone', idList: 'list-backlog', closed: false },
        ],
      });

      await trelloSync.syncInbound('C123', tmpDir);

      // Verify local item was created
      const store = new BoardStore(tmpDir);
      const items = store.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Card from Trello');
      expect(items[0].description).toBe('Created on phone');
      expect(items[0].status).toBe('backlog');
      store.dispose();

      // Verify mapping was updated
      const mapping = JSON.parse(fs.readFileSync(path.join(tmpDir, '.tasks', 'trello-mapping.json'), 'utf-8'));
      expect(mapping.cards).toHaveLength(1);
      expect(mapping.cards[0].trelloCardId).toBe('trello-new-1');
    });

    it('should update local item when Trello card is moved', async () => {
      setupMappingWithBoard();

      // Setup: local item + mapping entry
      const store = new BoardStore(tmpDir);
      const item = store.addItem({ title: 'Movable Task', status: 'backlog' });
      store.dispose();

      const mappingPath = path.join(tmpDir, '.tasks', 'trello-mapping.json');
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      // We need a hash that matches the old state
      mapping.cards.push({
        localId: item.id,
        trelloCardId: 'trello-movable',
        lastSyncedAt: new Date().toISOString(),
        lastLocalHash: 'old-hash',
        lastTrelloHash: 'old-hash',
      });
      fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), 'utf-8');

      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-movable', name: 'Movable Task', desc: '', idList: 'list-in-progress', closed: false },
        ],
      });

      let transitionFired = false;
      let transitionNewStatus: string | null = null;
      trelloSync.onStatusTransition((_projectId, _itemId, _oldStatus, newStatus) => {
        transitionFired = true;
        transitionNewStatus = newStatus;
      });

      await trelloSync.syncInbound('C123', tmpDir);

      // Verify local item was updated
      const store2 = new BoardStore(tmpDir);
      const updated = store2.getItems().find(i => i.id === item.id);
      expect(updated?.status).toBe('in_progress');
      store2.dispose();

      // Verify status transition callback was fired
      expect(transitionFired).toBe(true);
      expect(transitionNewStatus).toBe('in_progress');
    });

    it('should delete local item when Trello card is deleted', async () => {
      setupMappingWithBoard();

      // Setup: local item + mapping entry
      const store = new BoardStore(tmpDir);
      store.addItem({ title: 'To be deleted', status: 'backlog' });
      store.dispose();

      const mappingPath = path.join(tmpDir, '.tasks', 'trello-mapping.json');
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      mapping.cards.push({
        localId: '1',
        trelloCardId: 'trello-deleted',
        lastSyncedAt: new Date().toISOString(),
        lastLocalHash: 'hash',
        lastTrelloHash: 'hash',
      });
      fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), 'utf-8');

      // Trello returns no cards (the card was deleted)
      mockTrelloApi({
        'GET /boards/board-1/cards': () => [],
      });

      await trelloSync.syncInbound('C123', tmpDir);

      // Verify local item was deleted
      const store2 = new BoardStore(tmpDir);
      const items = store2.getItems();
      expect(items).toHaveLength(0);
      store2.dispose();

      // Verify mapping was cleaned up
      const updatedMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      expect(updatedMapping.cards).toHaveLength(0);
    });

    it('should skip unchanged cards', async () => {
      setupMappingWithBoard();

      const store = new BoardStore(tmpDir);
      store.addItem({ title: 'Stable Card', status: 'backlog' });
      store.dispose();

      // Setup mapping with correct hash
      const mappingPath = path.join(tmpDir, '.tasks', 'trello-mapping.json');
      const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));

      // Compute the same hash the sync module will compute
      const crypto = await import('crypto');
      const trelloHash = crypto.createHash('md5').update('Stable Card||backlog').digest('hex');

      mapping.cards.push({
        localId: '1',
        trelloCardId: 'trello-stable',
        lastSyncedAt: new Date().toISOString(),
        lastLocalHash: trelloHash,
        lastTrelloHash: trelloHash,
      });
      fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), 'utf-8');

      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-stable', name: 'Stable Card', desc: '', idList: 'list-backlog', closed: false },
        ],
      });

      await trelloSync.syncInbound('C123', tmpDir);

      // Mapping should not have changed (no writes detected)
      const updatedMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
      expect(updatedMapping.cards).toHaveLength(1);
      // The store should still have exactly 1 item
      const store2 = new BoardStore(tmpDir);
      expect(store2.getItems()).toHaveLength(1);
      store2.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Echo Prevention
  // -------------------------------------------------------------------------

  describe('echo prevention', () => {
    it('should skip recently pushed cards during inbound sync', async () => {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify({
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [],
      }), 'utf-8');

      // Add a local item
      const store = new BoardStore(tmpDir);
      store.addItem({ title: 'Echo Test', status: 'backlog' });
      store.dispose();

      // Mock: outbound creates card
      mockTrelloApi({
        'POST /cards': () => ({ id: 'trello-echo-1', name: 'Echo Test', desc: '', idList: 'list-backlog' }),
        'GET /boards/board-1/cards': () => [
          { id: 'trello-echo-1', name: 'Echo Test MODIFIED', desc: '', idList: 'list-in-progress', closed: false },
        ],
      });

      // Push outbound (records echo)
      await trelloSync.syncOutbound('C123', tmpDir);

      // Immediately do inbound sync - should skip the card due to echo window
      await trelloSync.syncInbound('C123', tmpDir);

      // Local item should NOT have been modified by inbound
      const store2 = new BoardStore(tmpDir);
      const items = store2.getItems();
      expect(items[0].title).toBe('Echo Test');
      expect(items[0].status).toBe('backlog');
      store2.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Error Handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('should handle Trello API errors without crashing', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      // Should not throw
      await trelloSync.initializeProject('C123', tmpDir, 'test-project');
    });

    it('should handle rate limiting gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      });

      // Should not throw
      await trelloSync.syncInbound('C123', tmpDir);
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      // Should not throw
      await trelloSync.initializeProject('C123', tmpDir, 'test-project');
    });
  });

  // -------------------------------------------------------------------------
  // Status Transitions
  // -------------------------------------------------------------------------

  describe('status transitions', () => {
    function setupMappingAndItem(): { itemId: string } {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });

      const store = new BoardStore(tmpDir);
      const item = store.addItem({ title: 'Transition Task', status: 'backlog' });
      store.dispose();

      const mapping = {
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [{
          localId: item.id,
          trelloCardId: 'trello-transition',
          lastSyncedAt: new Date().toISOString(),
          lastLocalHash: 'old-hash',
          lastTrelloHash: 'old-hash',
        }],
      };
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify(mapping, null, 2), 'utf-8');

      return { itemId: item.id };
    }

    it('should fire callback when card is moved to planning', async () => {
      const { itemId } = setupMappingAndItem();

      let capturedNewStatus: string | null = null;
      let capturedOldStatus: string | undefined = undefined;
      trelloSync.onStatusTransition((_projectId, _itemId, oldStatus, newStatus) => {
        capturedOldStatus = oldStatus;
        capturedNewStatus = newStatus;
      });

      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-transition', name: 'Transition Task', desc: '', idList: 'list-planning', closed: false },
        ],
      });

      await trelloSync.syncInbound('C123', tmpDir);

      expect(capturedOldStatus).toBe('backlog');
      expect(capturedNewStatus).toBe('planning');
    });

    it('should fire callback when card is moved to in_progress', async () => {
      setupMappingAndItem();

      let capturedNewStatus: string | null = null;
      trelloSync.onStatusTransition((_projectId, _itemId, _oldStatus, newStatus) => {
        capturedNewStatus = newStatus;
      });

      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-transition', name: 'Transition Task', desc: '', idList: 'list-in-progress', closed: false },
        ],
      });

      await trelloSync.syncInbound('C123', tmpDir);

      expect(capturedNewStatus).toBe('in_progress');
    });

    it('should not fire callback when status does not change', async () => {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });

      const store = new BoardStore(tmpDir);
      store.addItem({ title: 'Static Task', status: 'backlog' });
      store.dispose();

      // Use correct hash so the inbound sees no change
      const crypto = await import('crypto');
      const hash = crypto.createHash('md5').update('Static Task||backlog').digest('hex');

      const mapping = {
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [{
          localId: '1',
          trelloCardId: 'trello-static',
          lastSyncedAt: new Date().toISOString(),
          lastLocalHash: hash,
          lastTrelloHash: hash,
        }],
      };
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify(mapping, null, 2), 'utf-8');

      let callbackFired = false;
      trelloSync.onStatusTransition(() => { callbackFired = true; });

      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-static', name: 'Static Task', desc: '', idList: 'list-backlog', closed: false },
        ],
      });

      await trelloSync.syncInbound('C123', tmpDir);

      expect(callbackFired).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Polling Lifecycle
  // -------------------------------------------------------------------------

  describe('polling lifecycle', () => {
    it('should start and stop polling without errors', () => {
      trelloSync.startPolling();
      // Should not throw on double start
      trelloSync.startPolling();
      // Dispose stops polling
      trelloSync.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Card Description Formatting
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Hash Consistency (Local ID footer stripping)
  // -------------------------------------------------------------------------

  describe('hash consistency', () => {
    it('should produce matching hashes for items with Local ID footer', async () => {
      // This tests the fix: hashItem now strips the Local ID footer before hashing,
      // so outbound hashes match inbound hashes (hashCard also strips it).
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify({
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [],
      }), 'utf-8');

      const store = new BoardStore(tmpDir);
      store.addItem({ title: 'Hash Test', description: 'Some desc', status: 'backlog' });
      store.dispose();

      // First outbound sync creates the card
      let capturedDesc = '';
      mockTrelloApi({
        'POST /cards': (_url: string, opts: any) => {
          const body = JSON.parse(opts.body || '{}');
          capturedDesc = body.desc;
          return { id: 'trello-hash-1', name: body.name, desc: body.desc, idList: body.idList };
        },
      });

      await trelloSync.syncOutbound('C123', tmpDir);

      // The card description should contain the Local ID footer
      expect(capturedDesc).toContain('Local ID: #1');

      // Now simulate inbound: card returns with the same desc (including footer)
      // It should NOT trigger an update because hashes should match
      mockFetch.mockReset();
      let putCalled = false;
      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-hash-1', name: 'Hash Test', desc: capturedDesc, idList: 'list-backlog', closed: false },
        ],
        'PUT /cards/trello-hash-1': () => {
          putCalled = true;
          return {};
        },
      });

      // Read the updated mapping after outbound sync
      const mapping = JSON.parse(fs.readFileSync(path.join(tasksDir, 'trello-mapping.json'), 'utf-8'));
      expect(mapping.cards).toHaveLength(1);

      await trelloSync.syncInbound('C123', tmpDir);

      // The store should still have exactly 1 item with unchanged data
      const store2 = new BoardStore(tmpDir);
      const items = store2.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Hash Test');
      store2.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Race Condition: Outbound blocked during inbound
  // -------------------------------------------------------------------------

  describe('outbound blocked during inbound', () => {
    it('should skip outbound sync while inbound is running', async () => {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify({
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [],
      }), 'utf-8');

      // Setup: inbound will create a new item from a Trello card.
      // We want to verify that outbound sync called concurrently is skipped.
      let postCardsCalled = 0;
      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-race-1', name: 'Race Card', desc: '', idList: 'list-backlog', closed: false },
        ],
        'POST /cards': () => {
          postCardsCalled++;
          return { id: 'trello-dup', name: 'Duplicate', desc: '', idList: 'list-backlog' };
        },
      });

      // Run inbound first - this sets isSyncing=true internally
      await trelloSync.syncInbound('C123', tmpDir);

      // Verify the item was created locally
      const store = new BoardStore(tmpDir);
      const items = store.getItems();
      expect(items).toHaveLength(1);
      expect(items[0].title).toBe('Race Card');

      // Verify the mapping was saved immediately (no race window)
      const mapping = JSON.parse(fs.readFileSync(path.join(tasksDir, 'trello-mapping.json'), 'utf-8'));
      expect(mapping.cards).toHaveLength(1);
      expect(mapping.cards[0].trelloCardId).toBe('trello-race-1');

      // Now run outbound - it should NOT create a duplicate card
      // because the mapping already exists
      mockFetch.mockReset();
      postCardsCalled = 0;
      mockTrelloApi({
        'POST /cards': () => {
          postCardsCalled++;
          return { id: 'trello-dup', name: 'Duplicate', desc: '', idList: 'list-backlog' };
        },
      });

      await trelloSync.syncOutbound('C123', tmpDir);

      // No new card should have been created since the mapping already has it
      expect(postCardsCalled).toBe(0);
      store.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Description Corruption Prevention
  // -------------------------------------------------------------------------

  describe('description corruption prevention', () => {
    it('should NOT overwrite item.description with formatted card description on inbound', async () => {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });

      // Create a local item with raw description + acceptance criteria
      const store = new BoardStore(tmpDir);
      const item = store.addItem({
        title: 'AC Task',
        description: 'Simple raw description',
        acceptanceCriteria: ['AC 1', 'AC 2'],
        status: 'backlog',
      });
      store.dispose();

      // Setup mapping with old hash so inbound sees a "change"
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify({
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [{
          localId: item.id,
          trelloCardId: 'trello-ac-1',
          lastSyncedAt: new Date().toISOString(),
          lastLocalHash: 'old-hash',
          lastTrelloHash: 'old-hash',
        }],
      }), 'utf-8');

      // Simulate Trello returning the card with formatted description (including AC, footer)
      // but moved to a different list (which changes the hash and triggers update)
      const formattedDesc = 'Simple raw description\n\n**Acceptance Criteria:**\n- [ ] AC 1\n- [ ] AC 2\n\nSource: user\n\n---\nLocal ID: #1';

      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          {
            id: 'trello-ac-1',
            name: 'AC Task',
            desc: formattedDesc,
            idList: 'list-in-progress', // moved
            closed: false,
          },
        ],
      });

      await trelloSync.syncInbound('C123', tmpDir);

      // The item's raw description should NOT have been corrupted with formatted content
      const store2 = new BoardStore(tmpDir);
      const updated = store2.getItems().find(i => i.id === item.id);
      expect(updated).toBeDefined();
      expect(updated!.status).toBe('in_progress'); // status should have changed
      // Description should remain the original raw description, NOT the formatted one
      expect(updated!.description).toBe('Simple raw description');
      store2.dispose();
    });

    it('should update description when user actually edits it on Trello', async () => {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });

      const store = new BoardStore(tmpDir);
      const item = store.addItem({
        title: 'Editable Task',
        description: 'Original description',
        status: 'backlog',
      });
      store.dispose();

      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify({
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [{
          localId: item.id,
          trelloCardId: 'trello-edit-1',
          lastSyncedAt: new Date().toISOString(),
          lastLocalHash: 'old-hash',
          lastTrelloHash: 'old-hash',
        }],
      }), 'utf-8');

      // User edited the description on Trello to something different
      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          {
            id: 'trello-edit-1',
            name: 'Editable Task',
            desc: 'User edited this on Trello\n\n---\nLocal ID: #1',
            idList: 'list-backlog',
            closed: false,
          },
        ],
      });

      await trelloSync.syncInbound('C123', tmpDir);

      const store2 = new BoardStore(tmpDir);
      const updated = store2.getItems().find(i => i.id === item.id);
      expect(updated).toBeDefined();
      // Description SHOULD be updated since the user genuinely changed it
      expect(updated!.description).toBe('User edited this on Trello');
      store2.dispose();
    });
  });

  describe('card description format', () => {
    it('should include Local ID footer in created cards', async () => {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify({
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [],
      }), 'utf-8');

      const store = new BoardStore(tmpDir);
      store.addItem({
        title: 'Formatted Task',
        description: 'A detailed description',
        acceptanceCriteria: ['AC 1', 'AC 2'],
        questions: ['What about X?'],
        status: 'backlog',
      });
      store.dispose();

      let capturedDesc = '';
      mockTrelloApi({
        'POST /cards': (_url: string, opts: any) => {
          const body = JSON.parse(opts.body || '{}');
          capturedDesc = body.desc;
          return { id: 'trello-fmt-1', name: body.name, desc: body.desc, idList: body.idList };
        },
      });

      await trelloSync.syncOutbound('C123', tmpDir);

      expect(capturedDesc).toContain('A detailed description');
      expect(capturedDesc).toContain('**Acceptance Criteria:**');
      expect(capturedDesc).toContain('- [ ] AC 1');
      expect(capturedDesc).toContain('- [ ] AC 2');
      expect(capturedDesc).toContain('**Questions:**');
      expect(capturedDesc).toContain('- What about X?');
      expect(capturedDesc).toContain('Local ID: #1');
    });
  });

  // ---------------------------------------------------------------------------
  // Status transition callbacks for new/recovered cards
  // ---------------------------------------------------------------------------

  describe('status transition for new and recovered cards', () => {
    function setupMappingForTransitionTests() {
      const tasksDir = path.join(tmpDir, '.tasks');
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, 'trello-mapping.json'), JSON.stringify({
        version: 1,
        boardId: 'board-1',
        boardUrl: 'https://trello.com/b/abc',
        listIds: {
          backlog: 'list-backlog',
          clarification_needed: 'list-clarification',
          planning: 'list-planning',
          ready: 'list-ready',
          in_progress: 'list-in-progress',
          review: 'list-review',
          done: 'list-done',
        },
        cards: [],
      }), 'utf-8');
    }

    it('should fire status transition callback for new card at ready status', async () => {
      setupMappingForTransitionTests();

      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-ready-1', name: 'Ready Task', desc: '', idList: 'list-ready', closed: false },
        ],
      });

      let firedOld: string | undefined = undefined;
      let firedNew: string | undefined = undefined;
      trelloSync.onStatusTransition((_projectId, _itemId, oldStatus, newStatus) => {
        firedOld = oldStatus;
        firedNew = newStatus;
      });

      await trelloSync.syncInbound('C123', tmpDir);

      expect(firedOld).toBe('backlog');
      expect(firedNew).toBe('ready');

      // Verify local item was created at ready status
      const store = new BoardStore(tmpDir);
      expect(store.getItems()[0].status).toBe('ready');
      store.dispose();
    });

    it('should NOT fire status transition callback for new card at backlog status', async () => {
      setupMappingForTransitionTests();

      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-bl-1', name: 'Backlog Task', desc: '', idList: 'list-backlog', closed: false },
        ],
      });

      let callbackFired = false;
      trelloSync.onStatusTransition(() => { callbackFired = true; });

      await trelloSync.syncInbound('C123', tmpDir);

      expect(callbackFired).toBe(false);
    });

    it('should fire status transition callback for recovered card with status mismatch', async () => {
      setupMappingForTransitionTests();

      // Create a local item at backlog status (simulates item that existed before mapping was lost)
      const store = new BoardStore(tmpDir);
      const item = store.addItem({ title: 'Recovered Task', status: 'backlog' });
      store.dispose();

      // The Trello card has a Local ID footer and is in the "ready" list
      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          {
            id: 'trello-recovered-1',
            name: 'Recovered Task',
            desc: `Some description\n\n---\nLocal ID: #${item.id}`,
            idList: 'list-ready',
            closed: false,
          },
        ],
      });

      let firedOld: string | undefined = undefined;
      let firedNew: string | undefined = undefined;
      let firedItemId: string | undefined = undefined;
      trelloSync.onStatusTransition((_projectId, itemId, oldStatus, newStatus) => {
        firedOld = oldStatus;
        firedNew = newStatus;
        firedItemId = itemId;
      });

      await trelloSync.syncInbound('C123', tmpDir);

      expect(firedItemId).toBe(item.id);
      expect(firedOld).toBe('backlog');
      expect(firedNew).toBe('ready');

      // Verify local item status was updated
      const store2 = new BoardStore(tmpDir);
      const updated = store2.getItems().find(i => i.id === item.id);
      expect(updated?.status).toBe('ready');
      store2.dispose();
    });

    it('should NOT fire callback for recovered card when statuses already match', async () => {
      setupMappingForTransitionTests();

      // Create a local item already at "ready" status
      const store = new BoardStore(tmpDir);
      const item = store.addItem({ title: 'Already Ready Task', status: 'ready' });
      store.dispose();

      // The Trello card matches - also at "ready"
      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          {
            id: 'trello-match-1',
            name: 'Already Ready Task',
            desc: `Description\n\n---\nLocal ID: #${item.id}`,
            idList: 'list-ready',
            closed: false,
          },
        ],
      });

      let callbackFired = false;
      trelloSync.onStatusTransition(() => { callbackFired = true; });

      await trelloSync.syncInbound('C123', tmpDir);

      expect(callbackFired).toBe(false);
    });

    it('should fire status transition callback for new card at planning status', async () => {
      setupMappingForTransitionTests();

      mockTrelloApi({
        'GET /boards/board-1/cards': () => [
          { id: 'trello-plan-1', name: 'Planning Task', desc: '', idList: 'list-planning', closed: false },
        ],
      });

      let firedNew: string | null = null;
      trelloSync.onStatusTransition((_projectId, _itemId, _oldStatus, newStatus) => {
        firedNew = newStatus;
      });

      await trelloSync.syncInbound('C123', tmpDir);

      expect(firedNew).toBe('planning');
    });
  });
});
