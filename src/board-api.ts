import express, { Request, Response, NextFunction } from 'express';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Logger } from './logger.js';
import { ProjectConfig } from './project-config.js';
import { BoardStore } from './board-store.js';
import { BoardData, KanbanItem, KanbanStatus, KANBAN_STATUSES } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Represents a single SSE client connection.
 */
interface SSEClient {
  id: string;
  projectId: string;
  res: Response;
}

/**
 * Express REST API + SSE server for the kanban board.
 *
 * Provides CRUD endpoints for board items, project listing,
 * and Server-Sent Events for real-time board updates.
 */
/**
 * Callback for status transitions, triggered when a task moves to a new column.
 */
export type StatusTransitionCallback = (
  projectId: string,
  itemId: string,
  oldStatus: KanbanStatus | undefined,
  newStatus: KanbanStatus,
  projectPath: string,
) => void;

export class BoardApiServer {
  private logger = new Logger('BoardApiServer');
  private projectConfig: ProjectConfig;
  private app: express.Application;
  private server: http.Server | null = null;
  private stores: Map<string, BoardStore> = new Map();
  private sseClients: SSEClient[] = [];
  private clientIdCounter = 0;
  private statusTransitionCallbacks: StatusTransitionCallback[] = [];

  constructor(projectConfig: ProjectConfig) {
    this.projectConfig = projectConfig;
    this.app = this.createApp();
  }

  /**
   * Register a callback that fires when a task's status changes via the API.
   */
  onStatusTransition(callback: StatusTransitionCallback): void {
    this.statusTransitionCallbacks.push(callback);
  }

  private fireStatusTransition(
    projectId: string,
    itemId: string,
    oldStatus: KanbanStatus | undefined,
    newStatus: KanbanStatus,
    projectPath: string,
  ): void {
    for (const cb of this.statusTransitionCallbacks) {
      try {
        cb(projectId, itemId, oldStatus, newStatus, projectPath);
      } catch (err) {
        this.logger.error('Error in status transition callback', { error: err });
      }
    }
  }

  /**
   * Start the HTTP server on the given port.
   */
  async start(port: number = 7000): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(port, () => {
          this.logger.info('Board API server started', { port });
          resolve();
        });

        this.server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            this.logger.error(`Port ${port} is already in use`, err);
          }
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Gracefully stop the HTTP server and clean up all resources.
   */
  async stop(): Promise<void> {
    // Close all SSE connections
    for (const client of this.sseClients) {
      try {
        client.res.end();
      } catch {
        // Client may already be disconnected
      }
    }
    this.sseClients = [];

    // Dispose all board stores
    for (const store of this.stores.values()) {
      store.dispose();
    }
    this.stores.clear();

    // Close the HTTP server
    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.close((err) => {
          if (err) {
            this.logger.error('Error stopping board API server', err);
            reject(err);
          } else {
            this.logger.info('Board API server stopped');
            this.server = null;
            resolve();
          }
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Express app setup
  // ---------------------------------------------------------------------------

  private createApp(): express.Application {
    const app = express();

    // Parse JSON request bodies
    app.use(express.json());

    // CORS for local development
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (_req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }

      next();
    });

    // --- API routes (registered before static files) ---

    app.get('/api/projects', this.handleListProjects.bind(this));
    app.get('/api/projects/:id/board', this.handleGetBoard.bind(this));
    app.post('/api/projects/:id/board/items', this.handleAddItem.bind(this));
    app.patch('/api/projects/:id/board/items/:itemId', this.handleUpdateItem.bind(this));
    app.delete('/api/projects/:id/board/items/:itemId', this.handleDeleteItem.bind(this));
    app.get('/api/projects/:id/board/events', this.handleSSE.bind(this));

    // --- Static files & SPA fallback ---

    const webDir = path.join(dirname(__dirname), 'dist', 'web');
    if (fs.existsSync(webDir)) {
      app.use(express.static(webDir));

      // SPA fallback: serve index.html for all non-API routes
      // Express 5 uses {*param} syntax instead of bare *
      app.get('{*path}', (_req: Request, res: Response) => {
        const indexPath = path.join(webDir, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.sendFile(indexPath);
        } else {
          res.status(404).json({ error: 'Web UI not found' });
        }
      });
    }

    return app;
  }

  // ---------------------------------------------------------------------------
  // Private: Store management
  // ---------------------------------------------------------------------------

  /**
   * Get or create a BoardStore for the given project (channel) ID.
   * Returns null if the project is not found in ProjectConfig.
   */
  private getStore(projectId: string): BoardStore | null {
    const existing = this.stores.get(projectId);
    if (existing) return existing;

    const mapping = this.projectConfig.getByChannelId(projectId);
    if (!mapping) return null;

    const store = new BoardStore(mapping.projectPath);

    // Watch for external changes (e.g., Claude modifying the board file)
    // and push SSE events to all connected clients for this project.
    store.onChanged(() => {
      this.pushSSEUpdate(projectId, store.load());
    });

    this.stores.set(projectId, store);
    return store;
  }

  // ---------------------------------------------------------------------------
  // Private: SSE management
  // ---------------------------------------------------------------------------

  /**
   * Push a board data update to all SSE clients subscribed to a project.
   */
  private pushSSEUpdate(projectId: string, data: BoardData): void {
    const payload = JSON.stringify(data);
    const event = `event: board-update\ndata: ${payload}\n\n`;

    const toRemove: SSEClient[] = [];
    for (const client of this.sseClients) {
      if (client.projectId !== projectId) continue;

      try {
        client.res.write(event);
      } catch {
        toRemove.push(client);
      }
    }

    // Remove dead clients
    if (toRemove.length > 0) {
      this.sseClients = this.sseClients.filter(c => !toRemove.includes(c));
      this.logger.debug('Removed dead SSE clients', { removed: toRemove.length });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Route handlers
  // ---------------------------------------------------------------------------

  /**
   * GET /api/projects
   * List all projects with a board summary (item count by status).
   */
  private handleListProjects(_req: Request, res: Response): void {
    try {
      const projects = this.projectConfig.getAll();
      const result = projects.map((mapping) => {
        // Lazily load board to get summary counts
        const store = this.getStore(mapping.channelId);
        let itemCount = 0;
        let statusCounts: Record<string, number> = {};

        if (store) {
          const items = store.getItems();
          itemCount = items.length;
          for (const item of items) {
            statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
          }
        }

        return {
          id: mapping.channelId,
          channelName: mapping.channelName,
          projectName: mapping.projectName,
          projectPath: mapping.projectPath,
          itemCount,
          statusCounts,
        };
      });

      res.json({ projects: result });
    } catch (error) {
      this.logger.error('Failed to list projects', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * GET /api/projects/:id/board
   * Full board data for a project.
   */
  private handleGetBoard(req: Request, res: Response): void {
    try {
      const store = this.getStore(req.params.id);
      if (!store) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const data = store.load();
      res.json(data);
    } catch (error) {
      this.logger.error('Failed to get board', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * POST /api/projects/:id/board/items
   * Add a new item to the board.
   * Body: { title: string, description?: string, status?: KanbanStatus }
   */
  private handleAddItem(req: Request, res: Response): void {
    try {
      const store = this.getStore(req.params.id);
      if (!store) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const { title, description, status } = req.body;

      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        res.status(400).json({ error: 'title is required and must be a non-empty string' });
        return;
      }

      if (status !== undefined && !KANBAN_STATUSES.includes(status)) {
        res.status(400).json({
          error: `Invalid status. Must be one of: ${KANBAN_STATUSES.join(', ')}`,
        });
        return;
      }

      const partial: Partial<KanbanItem> = {
        title: title.trim(),
        source: 'user',
      };

      if (description !== undefined) {
        if (typeof description !== 'string') {
          res.status(400).json({ error: 'description must be a string' });
          return;
        }
        partial.description = description;
      }

      if (status !== undefined) {
        partial.status = status;
      }

      const item = store.addItem(partial);

      // Push SSE update to connected clients after our own mutation
      this.pushSSEUpdate(req.params.id, store.load());

      res.status(201).json(item);
    } catch (error) {
      this.logger.error('Failed to add item', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * PATCH /api/projects/:id/board/items/:itemId
   * Update an existing item (move, edit fields).
   * Body: Partial<KanbanItem> fields.
   */
  private handleUpdateItem(req: Request, res: Response): void {
    try {
      const store = this.getStore(req.params.id);
      if (!store) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const { itemId } = req.params;
      const updates = req.body;

      if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'Request body must contain at least one field to update' });
        return;
      }

      // Validate status if provided
      if (updates.status !== undefined && !KANBAN_STATUSES.includes(updates.status)) {
        res.status(400).json({
          error: `Invalid status. Must be one of: ${KANBAN_STATUSES.join(', ')}`,
        });
        return;
      }

      // Validate title if provided
      if (updates.title !== undefined) {
        if (typeof updates.title !== 'string' || updates.title.trim().length === 0) {
          res.status(400).json({ error: 'title must be a non-empty string' });
          return;
        }
        updates.title = updates.title.trim();
      }

      // Validate description if provided
      if (updates.description !== undefined && typeof updates.description !== 'string') {
        res.status(400).json({ error: 'description must be a string' });
        return;
      }

      // Only allow safe fields to be updated
      const allowedFields = ['title', 'description', 'status', 'assignee', 'acceptanceCriteria', 'questions'];
      const safeUpdates: Partial<KanbanItem> = {};
      for (const key of allowedFields) {
        if ((updates as any)[key] !== undefined) {
          (safeUpdates as any)[key] = (updates as any)[key];
        }
      }

      // Capture old status before update for transition detection
      const existingItem = store.getItems().find(i => i.id === itemId);
      const oldStatus = existingItem?.status;

      const updated = store.updateItem(itemId, safeUpdates);
      if (!updated) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }

      // Push SSE update after our own mutation
      this.pushSSEUpdate(req.params.id, store.load());

      // Fire status transition callback if status changed
      if (safeUpdates.status && oldStatus !== safeUpdates.status) {
        const mapping = this.projectConfig.getByChannelId(req.params.id);
        if (mapping) {
          this.fireStatusTransition(
            req.params.id,
            itemId,
            oldStatus,
            safeUpdates.status as KanbanStatus,
            mapping.projectPath,
          );
        }
      }

      res.json(updated);
    } catch (error) {
      this.logger.error('Failed to update item', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * DELETE /api/projects/:id/board/items/:itemId
   * Delete an item from the board.
   */
  private handleDeleteItem(req: Request, res: Response): void {
    try {
      const store = this.getStore(req.params.id);
      if (!store) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const { itemId } = req.params;
      const deleted = store.deleteItem(itemId);

      if (!deleted) {
        res.status(404).json({ error: 'Item not found' });
        return;
      }

      // Push SSE update after deletion
      this.pushSSEUpdate(req.params.id, store.load());

      res.status(204).send();
    } catch (error) {
      this.logger.error('Failed to delete item', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * GET /api/projects/:id/board/events
   * Server-Sent Events stream for real-time board updates.
   *
   * The client receives:
   * - An initial `board-update` event with the full board data on connection
   * - Subsequent `board-update` events whenever the board changes
   */
  private handleSSE(req: Request, res: Response): void {
    const projectId = req.params.id;

    const store = this.getStore(projectId);
    if (!store) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial board state
    const initialData = store.load();
    const initialPayload = JSON.stringify(initialData);
    res.write(`event: board-update\ndata: ${initialPayload}\n\n`);

    // Register this client
    const clientId = `sse-${++this.clientIdCounter}`;
    const client: SSEClient = { id: clientId, projectId, res };
    this.sseClients.push(client);

    this.logger.debug('SSE client connected', { clientId, projectId, totalClients: this.sseClients.length });

    // Send periodic keep-alive comments to prevent timeout
    const keepAliveInterval = setInterval(() => {
      try {
        res.write(':keep-alive\n\n');
      } catch {
        clearInterval(keepAliveInterval);
      }
    }, 30_000);

    // Clean up on disconnect
    req.on('close', () => {
      clearInterval(keepAliveInterval);
      this.sseClients = this.sseClients.filter(c => c.id !== clientId);
      this.logger.debug('SSE client disconnected', { clientId, projectId, totalClients: this.sseClients.length });
    });
  }
}
