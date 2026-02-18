import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoardApiServer } from './board-api.js';
import { ProjectConfig } from './project-config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

// Helper: make HTTP requests to the test server
function request(
  port: number,
  method: string,
  urlPath: string,
  body?: any,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode || 0, headers: res.headers, body: parsed });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Helper: open an SSE connection, collect events, return a controller
function openSSE(
  port: number,
  urlPath: string,
): { events: Array<{ event: string; data: any }>; close: () => void; waitForEvents: (count: number, timeoutMs?: number) => Promise<void> } {
  const events: Array<{ event: string; data: any }> = [];
  let resolveWaiter: (() => void) | null = null;
  let targetCount = 0;

  const req = http.get(
    { hostname: '127.0.0.1', port, path: urlPath, headers: { Accept: 'text/event-stream' } },
    (res) => {
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        // Parse SSE events from buffer
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (part.startsWith(':')) continue; // comment / keep-alive
          const eventMatch = part.match(/^event:\s*(.+)$/m);
          const dataMatch = part.match(/^data:\s*(.+)$/m);
          if (eventMatch && dataMatch) {
            let parsed: any;
            try {
              parsed = JSON.parse(dataMatch[1]);
            } catch {
              parsed = dataMatch[1];
            }
            events.push({ event: eventMatch[1], data: parsed });

            if (resolveWaiter && events.length >= targetCount) {
              resolveWaiter();
              resolveWaiter = null;
            }
          }
        }
      });
    },
  );

  return {
    events,
    close: () => {
      req.destroy();
    },
    waitForEvents: (count: number, timeoutMs: number = 5000) => {
      if (events.length >= count) return Promise.resolve();
      targetCount = count;
      return new Promise<void>((resolve, reject) => {
        resolveWaiter = resolve;
        setTimeout(() => {
          if (resolveWaiter) {
            resolveWaiter = null;
            reject(new Error(`Timed out waiting for ${count} SSE events, got ${events.length}`));
          }
        }, timeoutMs);
      });
    },
  };
}

// Unique temp dir per test run
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Monotonically incrementing port counter to guarantee no collisions
let portCounter = 18_200 + Math.floor(Math.random() * 800);
function nextPort(): number {
  return portCounter++;
}

describe('BoardApiServer', () => {
  let projectConfigPath: string;
  let projectConfig: ProjectConfig;
  let server: BoardApiServer;
  let port: number;
  let projectDir: string;

  beforeEach(async () => {
    // Create a temp project directory
    projectDir = makeTempDir('board-api-test-project-');

    // Create a temp config file and seed it with one project
    projectConfigPath = path.join(os.tmpdir(), `board-api-config-${Date.now()}-${nextPort()}.json`);
    projectConfig = new ProjectConfig(projectConfigPath);
    projectConfig.upsert({
      channelId: 'C_TEST',
      channelName: 'proj-testproject',
      projectPath: projectDir,
      projectName: 'testproject',
      listId: null,
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    });

    // Pick a guaranteed-unique port
    port = nextPort();

    server = new BoardApiServer(projectConfig);
    await server.start(port);
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }

    // Cleanup temp files
    try { fs.unlinkSync(projectConfigPath); } catch { /* ignore */ }
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // GET /api/projects
  // -------------------------------------------------------------------------
  describe('GET /api/projects', () => {
    it('should return the list of projects with board summary', async () => {
      const res = await request(port, 'GET', '/api/projects');
      expect(res.status).toBe(200);
      expect(res.body.projects).toHaveLength(1);

      const proj = res.body.projects[0];
      expect(proj.id).toBe('C_TEST');
      expect(proj.projectName).toBe('testproject');
      expect(proj.itemCount).toBe(0);
      expect(proj.statusCounts).toEqual({});
    });

    it('should reflect item counts after adding items', async () => {
      // Add items via the API
      await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'Task A' });
      await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'Task B', status: 'in_progress' });

      const res = await request(port, 'GET', '/api/projects');
      const proj = res.body.projects[0];
      expect(proj.itemCount).toBe(2);
      expect(proj.statusCounts.backlog).toBe(1);
      expect(proj.statusCounts.in_progress).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/board
  // -------------------------------------------------------------------------
  describe('GET /api/projects/:id/board', () => {
    it('should return full board data for an existing project', async () => {
      const res = await request(port, 'GET', '/api/projects/C_TEST/board');
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      // BoardStore derives projectName from path.basename(projectPath),
      // which is the temp directory name, not the ProjectConfig projectName.
      expect(typeof res.body.projectName).toBe('string');
      expect(res.body.projectName.length).toBeGreaterThan(0);
      expect(res.body.columns).toBeDefined();
      expect(Array.isArray(res.body.columns)).toBe(true);
      expect(res.body.columns.length).toBeGreaterThan(0);
      expect(res.body.items).toEqual([]);
    });

    it('should return 404 for a non-existent project', async () => {
      const res = await request(port, 'GET', '/api/projects/C_NONEXISTENT/board');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Project not found');
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/projects/:id/board/items
  // -------------------------------------------------------------------------
  describe('POST /api/projects/:id/board/items', () => {
    it('should create an item with defaults', async () => {
      const res = await request(port, 'POST', '/api/projects/C_TEST/board/items', {
        title: 'New task',
      });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe('1');
      expect(res.body.title).toBe('New task');
      expect(res.body.status).toBe('backlog');
      expect(res.body.source).toBe('user');
    });

    it('should accept optional description and status', async () => {
      const res = await request(port, 'POST', '/api/projects/C_TEST/board/items', {
        title: 'Important task',
        description: 'This is the description',
        status: 'in_progress',
      });
      expect(res.status).toBe(201);
      expect(res.body.description).toBe('This is the description');
      expect(res.body.status).toBe('in_progress');
    });

    it('should reject missing title', async () => {
      const res = await request(port, 'POST', '/api/projects/C_TEST/board/items', {});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('title');
    });

    it('should reject empty title', async () => {
      const res = await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: '   ' });
      expect(res.status).toBe(400);
    });

    it('should reject invalid status', async () => {
      const res = await request(port, 'POST', '/api/projects/C_TEST/board/items', {
        title: 'Task',
        status: 'invalid_status',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('status');
    });

    it('should reject non-string description', async () => {
      const res = await request(port, 'POST', '/api/projects/C_TEST/board/items', {
        title: 'Task',
        description: 123,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('description');
    });

    it('should return 404 for non-existent project', async () => {
      const res = await request(port, 'POST', '/api/projects/C_NONEXISTENT/board/items', {
        title: 'Task',
      });
      expect(res.status).toBe(404);
    });

    it('should increment item IDs', async () => {
      const r1 = await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'A' });
      const r2 = await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'B' });
      expect(r1.body.id).toBe('1');
      expect(r2.body.id).toBe('2');
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/projects/:id/board/items/:itemId
  // -------------------------------------------------------------------------
  describe('PATCH /api/projects/:id/board/items/:itemId', () => {
    beforeEach(async () => {
      await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'Original title' });
    });

    it('should update title', async () => {
      const res = await request(port, 'PATCH', '/api/projects/C_TEST/board/items/1', {
        title: 'Updated title',
      });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Updated title');
    });

    it('should update status (move)', async () => {
      const res = await request(port, 'PATCH', '/api/projects/C_TEST/board/items/1', {
        status: 'in_progress',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('in_progress');
    });

    it('should update description', async () => {
      const res = await request(port, 'PATCH', '/api/projects/C_TEST/board/items/1', {
        description: 'New description',
      });
      expect(res.status).toBe(200);
      expect(res.body.description).toBe('New description');
    });

    it('should reject empty body', async () => {
      const res = await request(port, 'PATCH', '/api/projects/C_TEST/board/items/1', {});
      expect(res.status).toBe(400);
    });

    it('should reject invalid status', async () => {
      const res = await request(port, 'PATCH', '/api/projects/C_TEST/board/items/1', {
        status: 'not_real',
      });
      expect(res.status).toBe(400);
    });

    it('should reject empty title', async () => {
      const res = await request(port, 'PATCH', '/api/projects/C_TEST/board/items/1', {
        title: '',
      });
      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent item', async () => {
      const res = await request(port, 'PATCH', '/api/projects/C_TEST/board/items/999', {
        title: 'X',
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Item not found');
    });

    it('should return 404 for non-existent project', async () => {
      const res = await request(port, 'PATCH', '/api/projects/C_NONEXISTENT/board/items/1', {
        title: 'X',
      });
      expect(res.status).toBe(404);
    });

    it('should not allow updating id, source, createdAt, or updatedAt', async () => {
      const res = await request(port, 'PATCH', '/api/projects/C_TEST/board/items/1', {
        id: '999',
        source: 'claude',
        createdAt: '2000-01-01',
        updatedAt: '2000-01-01',
        title: 'Also updating title so body is not empty on safe fields',
      });
      expect(res.status).toBe(200);
      // The item should still have its original id and source
      expect(res.body.id).toBe('1');
      expect(res.body.source).toBe('user');
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/projects/:id/board/items/:itemId
  // -------------------------------------------------------------------------
  describe('DELETE /api/projects/:id/board/items/:itemId', () => {
    beforeEach(async () => {
      await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'To delete' });
    });

    it('should delete an existing item', async () => {
      const res = await request(port, 'DELETE', '/api/projects/C_TEST/board/items/1');
      expect(res.status).toBe(204);

      // Verify deletion
      const board = await request(port, 'GET', '/api/projects/C_TEST/board');
      expect(board.body.items).toHaveLength(0);
    });

    it('should return 404 for non-existent item', async () => {
      const res = await request(port, 'DELETE', '/api/projects/C_TEST/board/items/999');
      expect(res.status).toBe(404);
    });

    it('should return 404 for non-existent project', async () => {
      const res = await request(port, 'DELETE', '/api/projects/C_NONEXISTENT/board/items/1');
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/projects/:id/board/events (SSE)
  // -------------------------------------------------------------------------
  describe('GET /api/projects/:id/board/events (SSE)', () => {
    it('should send initial board state on connection', async () => {
      // Add an item first
      await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'Existing task' });

      const sse = openSSE(port, '/api/projects/C_TEST/board/events');
      try {
        await sse.waitForEvents(1);

        expect(sse.events).toHaveLength(1);
        expect(sse.events[0].event).toBe('board-update');
        expect(sse.events[0].data.items).toHaveLength(1);
        expect(sse.events[0].data.items[0].title).toBe('Existing task');
      } finally {
        sse.close();
      }
    });

    it('should push updates when items are added via the API', async () => {
      const sse = openSSE(port, '/api/projects/C_TEST/board/events');
      try {
        // Wait for the initial event
        await sse.waitForEvents(1);

        // Add an item via the REST API
        await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'SSE test task' });

        // Wait for the update event
        await sse.waitForEvents(2);

        expect(sse.events).toHaveLength(2);
        // First event: initial state (empty board)
        expect(sse.events[0].data.items).toHaveLength(0);
        // Second event: after adding an item
        expect(sse.events[1].data.items).toHaveLength(1);
        expect(sse.events[1].data.items[0].title).toBe('SSE test task');
      } finally {
        sse.close();
      }
    });

    it('should push updates when items are updated via the API', async () => {
      await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'To update' });

      const sse = openSSE(port, '/api/projects/C_TEST/board/events');
      try {
        await sse.waitForEvents(1);

        await request(port, 'PATCH', '/api/projects/C_TEST/board/items/1', { status: 'done' });
        await sse.waitForEvents(2);

        expect(sse.events[1].data.items[0].status).toBe('done');
      } finally {
        sse.close();
      }
    });

    it('should push updates when items are deleted via the API', async () => {
      await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'To delete' });

      const sse = openSSE(port, '/api/projects/C_TEST/board/events');
      try {
        await sse.waitForEvents(1);

        await request(port, 'DELETE', '/api/projects/C_TEST/board/items/1');
        await sse.waitForEvents(2);

        expect(sse.events[1].data.items).toHaveLength(0);
      } finally {
        sse.close();
      }
    });

    it('should return 404 for non-existent project SSE', async () => {
      const res = await request(port, 'GET', '/api/projects/C_NONEXISTENT/board/events');
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // CORS
  // -------------------------------------------------------------------------
  describe('CORS headers', () => {
    it('should include CORS headers on API responses', async () => {
      const res = await request(port, 'GET', '/api/projects');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('should handle OPTIONS preflight', async () => {
      const res = await request(port, 'OPTIONS', '/api/projects');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-methods']).toContain('PATCH');
      expect(res.headers['access-control-allow-methods']).toContain('DELETE');
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  describe('server lifecycle', () => {
    it('should start and stop cleanly', async () => {
      // Server is already started in beforeEach; just verify it responds
      const res = await request(port, 'GET', '/api/projects');
      expect(res.status).toBe(200);

      // Stop is called in afterEach; this tests that it does not throw
    });
  });

  // -------------------------------------------------------------------------
  // Multiple projects
  // -------------------------------------------------------------------------
  describe('multiple projects', () => {
    let projectDir2: string;

    beforeEach(() => {
      projectDir2 = makeTempDir('board-api-test-project2-');
      projectConfig.upsert({
        channelId: 'C_TEST2',
        channelName: 'proj-second',
        projectPath: projectDir2,
        projectName: 'second',
        listId: null,
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });
    });

    afterEach(() => {
      try { fs.rmSync(projectDir2, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('should list both projects', async () => {
      const res = await request(port, 'GET', '/api/projects');
      expect(res.body.projects).toHaveLength(2);
    });

    it('should keep items isolated between projects', async () => {
      await request(port, 'POST', '/api/projects/C_TEST/board/items', { title: 'Project 1 task' });
      await request(port, 'POST', '/api/projects/C_TEST2/board/items', { title: 'Project 2 task' });

      const board1 = await request(port, 'GET', '/api/projects/C_TEST/board');
      const board2 = await request(port, 'GET', '/api/projects/C_TEST2/board');

      expect(board1.body.items).toHaveLength(1);
      expect(board1.body.items[0].title).toBe('Project 1 task');

      expect(board2.body.items).toHaveLength(1);
      expect(board2.body.items[0].title).toBe('Project 2 task');
    });

    it('should only push SSE events to clients of the matching project', async () => {
      const sse1 = openSSE(port, '/api/projects/C_TEST/board/events');
      const sse2 = openSSE(port, '/api/projects/C_TEST2/board/events');

      try {
        // Wait for initial events on both
        await sse1.waitForEvents(1);
        await sse2.waitForEvents(1);

        // Add item to project 2 only
        await request(port, 'POST', '/api/projects/C_TEST2/board/items', { title: 'Only in project 2' });

        // Project 2 SSE should get the update
        await sse2.waitForEvents(2);
        expect(sse2.events).toHaveLength(2);

        // Project 1 SSE should NOT have received another event
        // Give a small window to ensure no spurious event arrives
        await new Promise((r) => setTimeout(r, 100));
        expect(sse1.events).toHaveLength(1);
      } finally {
        sse1.close();
        sse2.close();
      }
    });
  });
});
