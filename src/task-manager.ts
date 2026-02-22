import bolt from '@slack/bolt';
const { App } = bolt;
type AppType = InstanceType<typeof App>;
import { Logger } from './logger.js';
import { ProjectConfig } from './project-config.js';
import { BoardStore } from './board-store.js';
import { TaskItem, TaskStatus } from './types.js';

export class TaskManager {
  private app: AppType;
  private projectConfig: ProjectConfig;
  private logger = new Logger('TaskManager');
  private stores: Map<string, BoardStore> = new Map();
  private listsAvailable: boolean | null = null;

  constructor(app: AppType, projectConfig: ProjectConfig) {
    this.app = app;
    this.projectConfig = projectConfig;
  }

  // --- Store management ---

  /**
   * Get or create a BoardStore for a channel.
   * Uses project path from ProjectConfig, falls back to in-memory-like behavior.
   */
  getStore(channelId: string): BoardStore {
    let store = this.stores.get(channelId);
    if (store) return store;

    // Look up project path from config
    const mapping = this.projectConfig.getByChannelId(channelId);
    if (mapping) {
      store = new BoardStore(mapping.projectPath);
      this.stores.set(channelId, store);
      return store;
    }

    // Fallback: use a temp-like path based on channel ID
    // This handles channels not yet mapped to a project
    const fallbackPath = `/tmp/tasks-${channelId}`;
    store = new BoardStore(fallbackPath);
    this.stores.set(channelId, store);
    return store;
  }

  /**
   * Get a BoardStore for a specific project path.
   */
  getStoreForProject(projectPath: string): BoardStore {
    // Check if we already have one cached for any channel using this path
    for (const [, store] of this.stores) {
      if (store.getProjectPath() === projectPath) {
        return store;
      }
    }

    const store = new BoardStore(projectPath);
    return store;
  }

  // --- List lifecycle (Slack Lists API) ---

  async ensureList(channelId: string, projectName: string): Promise<string | null> {
    const existingListId = this.projectConfig.getListIdForChannel(channelId);
    if (existingListId) return existingListId;

    const available = await this.checkListsAvailability();
    if (!available) {
      this.logger.debug('Slack Lists not available, using file-backed store', { channelId });
      this.getStore(channelId);
      return null;
    }

    try {
      const listId = await this.createList(projectName);
      if (listId) {
        await this.shareListWithChannel(listId, channelId);
        this.projectConfig.updateListId(channelId, listId);
      }
      return listId;
    } catch (error) {
      this.logger.warn('Failed to create Slack List, falling back to file-backed store', { error });
      this.getStore(channelId);
      return null;
    }
  }

  async createList(projectName: string): Promise<string | null> {
    try {
      const response: any = await this.app.client.apiCall('lists.create', {
        name: projectName,
        description: `Task board for ${projectName}`,
        default_view: 'board',
      });

      if (response.ok && response.list?.id) {
        this.logger.info('Created Slack List', { listId: response.list.id, projectName });
        return response.list.id;
      }

      this.logger.warn('Slack Lists create returned non-ok', { response });
      return null;
    } catch (error) {
      this.logger.error('Failed to create Slack List', error);
      return null;
    }
  }

  async shareListWithChannel(listId: string, channelId: string): Promise<void> {
    try {
      await this.app.client.apiCall('lists.addMember', {
        list_id: listId,
        channel_id: channelId,
      });
      this.logger.info('Shared list with channel', { listId, channelId });
    } catch (error) {
      this.logger.warn('Failed to share list with channel', { listId, channelId, error });
    }
  }

  // --- Item CRUD ---

  async addItem(
    channelId: string,
    title: string,
    status: TaskStatus = 'backlog',
    source: 'claude' | 'user' = 'user',
  ): Promise<TaskItem> {
    const store = this.getStore(channelId);
    return store.addItem({ title, status, source });
  }

  async updateItemStatus(
    channelId: string,
    itemRef: string,
    newStatus: TaskStatus,
  ): Promise<TaskItem | null> {
    const store = this.getStore(channelId);
    const item = store.findItem(itemRef);
    if (!item) return null;

    return store.moveItem(item.id, newStatus);
  }

  /**
   * Update an item's fields (used by task planner for AC, questions, etc).
   */
  async updateItem(
    channelId: string,
    itemRef: string,
    updates: Partial<TaskItem>,
  ): Promise<TaskItem | null> {
    const store = this.getStore(channelId);
    const item = store.findItem(itemRef);
    if (!item) return null;

    return store.updateItem(item.id, updates);
  }

  listItems(channelId: string): TaskItem[] {
    return this.getStore(channelId).getItems();
  }

  // --- Claude-to-Trello task bridge ---

  async syncTodosToTasks(
    channelId: string,
    todos: Array<{ id: string; content: string; status: string; priority?: string }>,
  ): Promise<void> {
    const store = this.getStore(channelId);

    const data = store.load();
    for (const todo of todos) {
      let taskStatus: TaskStatus;
      switch (todo.status) {
        case 'completed':
          taskStatus = 'review';
          break;
        case 'in_progress':
          taskStatus = 'in_progress';
          break;
        default:
          taskStatus = 'backlog';
      }

      const existing = data.items.find(
        i => i.source === 'claude' && i.title === todo.content,
      );

      if (existing) {
        if (existing.status !== taskStatus && existing.status !== 'done') {
          store.updateItem(existing.id, { status: taskStatus });
        }
      } else {
        store.addItem({
          title: todo.content,
          status: taskStatus,
          source: 'claude',
        });
      }
    }
  }

  // --- Feature detection ---

  async checkListsAvailability(): Promise<boolean> {
    if (this.listsAvailable !== null) {
      return this.listsAvailable;
    }

    try {
      await this.app.client.apiCall('lists.list', { limit: 1 });
      this.listsAvailable = true;
      this.logger.info('Slack Lists API is available');
    } catch (error: any) {
      this.listsAvailable = false;
      this.logger.info('Slack Lists API not available, using file-backed task store', {
        error: error.data?.error || error.message,
      });
    }

    return this.listsAvailable;
  }

  // --- Cleanup ---

  dispose(): void {
    for (const store of this.stores.values()) {
      store.dispose();
    }
    this.stores.clear();
  }

}
