import bolt from '@slack/bolt';
const { App } = bolt;
type AppType = InstanceType<typeof App>;
import { Logger } from './logger.js';
import { ProjectConfig } from './project-config.js';
import { BoardStore } from './board-store.js';
import { KanbanItem, KanbanStatus, KanbanCommand, KANBAN_STATUSES } from './types.js';

const STATUS_LABELS: Record<KanbanStatus, string> = {
  backlog: 'Backlog',
  clarification_needed: 'Clarification Needed',
  planning: 'Planning',
  ready: 'Ready to Execute',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

const STATUS_EMOJI: Record<KanbanStatus, string> = {
  backlog: '\u{1f4cb}',
  clarification_needed: '\u{2753}',
  planning: '\u{1f4d0}',
  ready: '\u{1f680}',
  in_progress: '\u{1f504}',
  review: '\u{1f440}',
  done: '\u{2705}',
};

export class KanbanManager {
  private app: AppType;
  private projectConfig: ProjectConfig;
  private logger = new Logger('KanbanManager');
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
    const fallbackPath = `/tmp/kanban-${channelId}`;
    store = new BoardStore(fallbackPath);
    this.stores.set(channelId, store);
    return store;
  }

  /**
   * Get a BoardStore for a specific project path (used by board API).
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
        name: `${projectName} - Kanban`,
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
    status: KanbanStatus = 'backlog',
    source: 'claude' | 'user' = 'user',
  ): Promise<KanbanItem> {
    const store = this.getStore(channelId);
    const item = store.addItem({ title, status, source });

    // Try syncing to Slack Lists
    const listId = this.projectConfig.getListIdForChannel(channelId);
    if (listId) {
      await this.syncItemToList(listId, item);
    }

    return item;
  }

  async updateItemStatus(
    channelId: string,
    itemRef: string,
    newStatus: KanbanStatus,
  ): Promise<KanbanItem | null> {
    const store = this.getStore(channelId);
    const item = store.findItem(itemRef);
    if (!item) return null;

    const updated = store.moveItem(item.id, newStatus);

    const listId = this.projectConfig.getListIdForChannel(channelId);
    if (listId && updated) {
      await this.syncItemStatusToList(listId, updated);
    }

    return updated;
  }

  /**
   * Update an item's fields (used by task planner for AC, questions, etc).
   */
  async updateItem(
    channelId: string,
    itemRef: string,
    updates: Partial<KanbanItem>,
  ): Promise<KanbanItem | null> {
    const store = this.getStore(channelId);
    const item = store.findItem(itemRef);
    if (!item) return null;

    return store.updateItem(item.id, updates);
  }

  listItems(channelId: string): KanbanItem[] {
    return this.getStore(channelId).getItems();
  }

  // --- Command parsing ---

  parseCommand(text: string): KanbanCommand | null {
    const trimmed = text.trim();

    // board
    if (/^board$/i.test(trimmed)) {
      return { type: 'board' };
    }

    // add task <description>
    const addMatch = trimmed.match(/^add\s+task\s+(.+)$/i);
    if (addMatch) {
      return { type: 'add', title: addMatch[1].trim() };
    }

    // done <ref>
    const doneMatch = trimmed.match(/^done\s+(.+)$/i);
    if (doneMatch) {
      return { type: 'done', ref: doneMatch[1].trim() };
    }

    // go <ref> - approve a planned task for implementation
    const goMatch = trimmed.match(/^go\s+(.+)$/i);
    if (goMatch) {
      return { type: 'go', ref: goMatch[1].trim() };
    }

    // answer <ref> <response> - answer clarification questions
    const answerMatch = trimmed.match(/^answer\s+(\S+)\s+(.+)$/i);
    if (answerMatch) {
      return { type: 'answer', ref: answerMatch[1].trim(), response: answerMatch[2].trim() };
    }

    // approve <ref> - accept completed work (review -> done)
    const approveMatch = trimmed.match(/^approve\s+(.+)$/i);
    if (approveMatch) {
      return { type: 'approve', ref: approveMatch[1].trim() };
    }

    // move <ref> <status>
    const moveMatch = trimmed.match(/^move\s+(\S+)\s+(\S+)$/i);
    if (moveMatch) {
      const status = moveMatch[2].toLowerCase() as KanbanStatus;
      if (KANBAN_STATUSES.includes(status)) {
        return { type: 'move', ref: moveMatch[1], status };
      }
    }

    // sync / sync projects
    if (/^sync(\s+projects?)?$/i.test(trimmed)) {
      return { type: 'sync' };
    }

    return null;
  }

  // --- Formatting ---

  formatBoard(items: KanbanItem[]): string {
    if (items.length === 0) {
      return '\u{1f4cb} *Kanban Board*\n\nNo tasks yet. Use `add task <description>` to add one.';
    }

    let message = '\u{1f4cb} *Kanban Board*\n\n';

    for (const status of KANBAN_STATUSES) {
      const statusItems = items.filter(i => i.status === status);
      if (statusItems.length === 0) continue;

      message += `*${STATUS_EMOJI[status]} ${STATUS_LABELS[status]}* (${statusItems.length})\n`;
      for (const item of statusItems) {
        const sourceTag = item.source === 'claude' ? ' `\u{1f916}`' : '';
        const strikethrough = status === 'done' ? '~' : '';
        message += `  ${strikethrough}#${item.id} ${item.title}${strikethrough}${sourceTag}`;

        // Show acceptance criteria count if present
        if (item.acceptanceCriteria && item.acceptanceCriteria.length > 0) {
          message += ` (${item.acceptanceCriteria.length} AC)`;
        }

        // Show questions count for clarification items
        if (status === 'clarification_needed' && item.questions && item.questions.length > 0) {
          message += ` \u{2753}${item.questions.length}`;
        }

        message += '\n';
      }
      message += '\n';
    }

    // Summary
    const done = items.filter(i => i.status === 'done').length;
    const total = items.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    message += `*Progress:* ${done}/${total} (${pct}%)`;

    return message;
  }

  formatItemCreated(item: KanbanItem): string {
    return `${STATUS_EMOJI[item.status]} Task *#${item.id}* added to *${STATUS_LABELS[item.status]}*: ${item.title}`;
  }

  formatItemMoved(item: KanbanItem): string {
    return `${STATUS_EMOJI[item.status]} Task *#${item.id}* moved to *${STATUS_LABELS[item.status]}*: ${item.title}`;
  }

  // --- Claude-to-Kanban bridge ---

  async syncTodosToKanban(
    channelId: string,
    todos: Array<{ id: string; content: string; status: string; priority?: string }>,
  ): Promise<void> {
    const store = this.getStore(channelId);

    for (const todo of todos) {
      let kanbanStatus: KanbanStatus;
      switch (todo.status) {
        case 'completed':
          kanbanStatus = 'review';
          break;
        case 'in_progress':
          kanbanStatus = 'in_progress';
          break;
        default:
          kanbanStatus = 'backlog';
      }

      const data = store.load();
      const existing = data.items.find(
        i => i.source === 'claude' && i.title === todo.content,
      );

      if (existing) {
        if (existing.status !== kanbanStatus && existing.status !== 'done') {
          store.updateItem(existing.id, { status: kanbanStatus });
        }
      } else {
        store.addItem({
          title: todo.content,
          status: kanbanStatus,
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
      this.logger.info('Slack Lists API not available, using file-backed kanban', {
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

  // --- Private helpers ---

  private async syncItemToList(listId: string, item: KanbanItem): Promise<void> {
    try {
      await this.app.client.apiCall('lists.items.create', {
        list_id: listId,
        item: {
          title: item.title,
          fields: {
            status: STATUS_LABELS[item.status],
            source: item.source,
          },
        },
      });
    } catch (error) {
      this.logger.warn('Failed to sync item to Slack List', { listId, item, error });
    }
  }

  private async syncItemStatusToList(listId: string, item: KanbanItem): Promise<void> {
    try {
      this.logger.debug('Would sync item status to Slack List', { listId, itemId: item.id, status: item.status });
    } catch (error) {
      this.logger.warn('Failed to sync item status to Slack List', { listId, item, error });
    }
  }
}
