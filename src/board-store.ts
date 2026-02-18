import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Logger } from './logger.js';
import { BoardData, BoardColumn, KanbanItem, KanbanStatus, DEFAULT_BOARD_COLUMNS } from './types.js';

export class BoardStore {
  private projectPath: string;
  private boardDir: string;
  private boardFile: string;
  private logger = new Logger('BoardStore');
  private watcher: fs.FSWatcher | null = null;
  private changeCallbacks: Array<() => void> = [];
  private lastWriteHash: string = '';

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.boardDir = path.join(projectPath, '.kanban');
    this.boardFile = path.join(this.boardDir, 'board.json');
  }

  /**
   * Ensure the .kanban directory exists.
   */
  private ensureDir(): void {
    if (!fs.existsSync(this.boardDir)) {
      fs.mkdirSync(this.boardDir, { recursive: true });
    }
  }

  /**
   * Load board data from disk. Creates default if file doesn't exist.
   */
  load(): BoardData {
    try {
      if (fs.existsSync(this.boardFile)) {
        const content = fs.readFileSync(this.boardFile, 'utf-8');
        const data = JSON.parse(content) as BoardData;

        // Migrate: ensure all default columns exist (e.g. 'ready' added later)
        const existingIds = new Set(data.columns.map(c => c.id));
        let migrated = false;
        for (const defaultCol of DEFAULT_BOARD_COLUMNS) {
          if (!existingIds.has(defaultCol.id)) {
            // Insert the new column at the correct position
            const defaultIndex = DEFAULT_BOARD_COLUMNS.indexOf(defaultCol);
            data.columns.splice(defaultIndex, 0, defaultCol);
            migrated = true;
          }
        }
        if (migrated) {
          this.save(data);
        }

        return data;
      }
    } catch (error) {
      this.logger.warn('Failed to load board data, creating fresh', { path: this.boardFile, error });
    }

    // Create default board
    const projectName = path.basename(this.projectPath);
    const data: BoardData = {
      version: 1,
      projectName,
      columns: [...DEFAULT_BOARD_COLUMNS],
      items: [],
      nextId: 1,
      updatedAt: new Date().toISOString(),
    };

    this.save(data);
    return data;
  }

  /**
   * Atomically write board data to disk (write to temp file, then rename).
   */
  save(data: BoardData): void {
    this.ensureDir();

    data.updatedAt = new Date().toISOString();
    const content = JSON.stringify(data, null, 2);
    const hash = crypto.createHash('md5').update(content).digest('hex');

    // Track our own writes to avoid triggering our own change callbacks
    this.lastWriteHash = hash;

    const tmpFile = path.join(this.boardDir, `.board.json.tmp.${Date.now()}`);
    try {
      fs.writeFileSync(tmpFile, content, 'utf-8');
      fs.renameSync(tmpFile, this.boardFile);
    } catch (error) {
      // Clean up temp file on failure
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      throw error;
    }
  }

  /**
   * Add an item to the board. Returns the created item.
   */
  addItem(partial: Partial<KanbanItem>): KanbanItem {
    const data = this.load();
    const now = new Date().toISOString();

    const item: KanbanItem = {
      id: String(data.nextId++),
      title: partial.title || 'Untitled',
      description: partial.description,
      acceptanceCriteria: partial.acceptanceCriteria,
      status: partial.status || 'backlog',
      source: partial.source || 'user',
      assignee: partial.assignee,
      questions: partial.questions,
      createdAt: now,
      updatedAt: now,
    };

    data.items.push(item);
    this.save(data);
    this.logger.info('Added board item', { projectPath: this.projectPath, item: { id: item.id, title: item.title } });
    return item;
  }

  /**
   * Update an existing item. Returns the updated item or null if not found.
   */
  updateItem(id: string, updates: Partial<KanbanItem>): KanbanItem | null {
    const data = this.load();
    const item = data.items.find(i => i.id === id);
    if (!item) return null;

    if (updates.title !== undefined) item.title = updates.title;
    if (updates.description !== undefined) item.description = updates.description;
    if (updates.acceptanceCriteria !== undefined) item.acceptanceCriteria = updates.acceptanceCriteria;
    if (updates.status !== undefined) item.status = updates.status;
    if (updates.assignee !== undefined) item.assignee = updates.assignee;
    if (updates.questions !== undefined) item.questions = updates.questions;
    if (updates.source !== undefined) item.source = updates.source;
    item.updatedAt = new Date().toISOString();

    this.save(data);
    this.logger.info('Updated board item', { id, updates: Object.keys(updates) });
    return item;
  }

  /**
   * Move an item to a new status column.
   */
  moveItem(id: string, newStatus: KanbanStatus): KanbanItem | null {
    return this.updateItem(id, { status: newStatus });
  }

  /**
   * Delete an item from the board. Returns true if deleted.
   */
  deleteItem(id: string): boolean {
    const data = this.load();
    const index = data.items.findIndex(i => i.id === id);
    if (index === -1) return false;

    data.items.splice(index, 1);
    this.save(data);
    this.logger.info('Deleted board item', { id });
    return true;
  }

  /**
   * Get all items.
   */
  getItems(): KanbanItem[] {
    return this.load().items;
  }

  /**
   * Get items filtered by status.
   */
  getItemsByStatus(status: KanbanStatus): KanbanItem[] {
    return this.load().items.filter(i => i.status === status);
  }

  /**
   * Find an item by ID, #ID, or partial title match.
   */
  findItem(ref: string): KanbanItem | null {
    const data = this.load();

    // Exact ID match
    const byId = data.items.find(i => i.id === ref);
    if (byId) return byId;

    // Strip # prefix
    const numRef = ref.replace(/^#/, '');
    const byNum = data.items.find(i => i.id === numRef);
    if (byNum) return byNum;

    // Partial title match
    const lower = ref.toLowerCase();
    return data.items.find(i => i.title.toLowerCase().includes(lower)) || null;
  }

  /**
   * Register a callback for when the board file changes externally.
   */
  onChanged(callback: () => void): void {
    this.changeCallbacks.push(callback);

    // Start watching if not already
    if (!this.watcher && fs.existsSync(this.boardFile)) {
      this.startWatching();
    }
  }

  /**
   * Start watching the board file for external changes.
   */
  private startWatching(): void {
    if (this.watcher) return;

    try {
      this.watcher = fs.watch(this.boardFile, (eventType) => {
        if (eventType !== 'change') return;

        // Check if this was our own write
        try {
          const content = fs.readFileSync(this.boardFile, 'utf-8');
          const hash = crypto.createHash('md5').update(content).digest('hex');
          if (hash === this.lastWriteHash) return;
        } catch {
          return;
        }

        this.logger.debug('Board file changed externally', { path: this.boardFile });
        for (const cb of this.changeCallbacks) {
          try { cb(); } catch (err) {
            this.logger.warn('Error in change callback', { error: err });
          }
        }
      });
    } catch (error) {
      this.logger.warn('Failed to watch board file', { path: this.boardFile, error });
    }
  }

  /**
   * Clean up watcher and callbacks.
   */
  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.changeCallbacks = [];
  }

  /**
   * Get the project path this store is associated with.
   */
  getProjectPath(): string {
    return this.projectPath;
  }

  /**
   * Get the board file path.
   */
  getBoardFilePath(): string {
    return this.boardFile;
  }
}
