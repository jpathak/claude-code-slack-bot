import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import fetch from 'node-fetch';
import { Logger } from './logger.js';
import { Config } from './config.js';
import { ProjectConfig } from './project-config.js';
import { BoardStore } from './board-store.js';
import { TaskItem, TaskStatus, TASK_STATUSES, DEFAULT_BOARD_COLUMNS } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrelloCardMapping {
  localId: string;
  trelloCardId: string;
  lastSyncedAt: string;
  lastLocalHash: string;
  lastTrelloHash: string;
  /** ID of the bot's clarification comment, used to detect user replies */
  clarificationCommentId?: string;
}

interface TrelloMapping {
  version: 1;
  boardId: string;
  boardUrl: string;
  listIds: Record<TaskStatus, string>;
  cards: TrelloCardMapping[];
}

interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  idList: string;
  closed: boolean;
}

interface TrelloComment {
  id: string;
  data: {
    text: string;
    card: { id: string; name: string };
  };
  date: string;
  memberCreator: {
    id: string;
    username: string;
    fullName: string;
  };
}

interface TrelloList {
  id: string;
  name: string;
  closed: boolean;
  pos: number;
}

interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  closed: boolean;
}

/**
 * Callback fired when an inbound Trello change moves a card to a new status.
 */
export type TrelloStatusTransitionCallback = (
  projectId: string,
  itemId: string,
  oldStatus: TaskStatus | undefined,
  newStatus: TaskStatus,
  projectPath: string,
) => void;

/**
 * Callback fired when a user replies to a clarification comment on a Trello card.
 */
export type TrelloClarificationReplyCallback = (
  projectId: string,
  itemId: string,
  replyText: string,
  projectPath: string,
) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRELLO_API_BASE = 'https://api.trello.com/1';
const OUTBOUND_DEBOUNCE_MS = 2000;
const ECHO_WINDOW_MS = 10000;

// Map our status IDs to user-friendly Trello list names matching DEFAULT_BOARD_COLUMNS
const STATUS_TO_LIST_NAME: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  clarification_needed: 'Clarification Needed',
  planning: 'Planning',
  ready: 'Ready to Execute',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

// Reverse lookup: Trello list name -> task status
const LIST_NAME_TO_STATUS: Record<string, TaskStatus> = {};
for (const [status, name] of Object.entries(STATUS_TO_LIST_NAME)) {
  LIST_NAME_TO_STATUS[name] = status as TaskStatus;
}

// ---------------------------------------------------------------------------
// TrelloSync
// ---------------------------------------------------------------------------

export class TrelloSync {
  private logger = new Logger('TrelloSync');
  private config: Config;
  private projectConfig: ProjectConfig;
  private statusTransitionCallback: TrelloStatusTransitionCallback | null = null;
  private clarificationReplyCallback: TrelloClarificationReplyCallback | null = null;

  // Polling state
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;

  // Per-project outbound debounce timers
  private outboundTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Per-project BoardStore instances (keyed by channelId)
  private stores: Map<string, BoardStore> = new Map();

  // Echo prevention: track recently pushed card IDs with timestamp
  // Key = trelloCardId, Value = timestamp when pushed
  private recentOutboundSyncs: Map<string, number> = new Map();

  // Per-project outbound sync lock to prevent concurrent outbound syncs
  // (which could both see the same unmapped items and create duplicates)
  private outboundInFlight: Set<string> = new Set();

  constructor(config: Config, projectConfig: ProjectConfig) {
    this.config = config;
    this.projectConfig = projectConfig;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Set callback for status transitions from Trello (inbound card moves).
   */
  onStatusTransition(callback: TrelloStatusTransitionCallback): void {
    this.statusTransitionCallback = callback;
  }

  /**
   * Set callback for user replies to clarification comments on Trello cards.
   */
  onClarificationReply(callback: TrelloClarificationReplyCallback): void {
    this.clarificationReplyCallback = callback;
  }

  /**
   * Initialize Trello sync for a single project.
   * Creates/finds the Trello board, ensures 7 lists, does initial reconciliation.
   */
  async initializeProject(channelId: string, projectPath: string, projectName: string): Promise<void> {
    try {
      this.logger.info('Initializing Trello sync for project', { projectName, projectPath });

      // Find or create a Trello board
      const board = await this.findOrCreateBoard(projectName);
      if (!board) {
        // API failure - fall back to existing mapping if available.
        // This prevents the bot from losing sync on transient network issues.
        const existingMapping = this.loadMapping(projectPath);
        if (existingMapping) {
          this.logger.warn('Using cached Trello mapping after API failure', {
            projectName,
            boardId: existingMapping.boardId,
          });
          // Still wire up watchers using the cached mapping
          this.wireOutboundWatcher(channelId, projectPath);
          return;
        }
        this.logger.error('Failed to find Trello board and no cached mapping exists', { projectName });
        return;
      }

      // Ensure the 7 lists exist
      const listIds = await this.ensureLists(board.id);
      if (!listIds) {
        this.logger.error('Failed to ensure Trello lists', { projectName });
        return;
      }

      // Load existing mapping or create a new one.
      // IMPORTANT: preserve the existing `cards` array so we don't lose
      // card ID mappings on bot restart (which would cause duplicate cards).
      const existingMapping = this.loadMapping(projectPath);
      const mapping: TrelloMapping = {
        version: 1,
        boardId: board.id,
        boardUrl: board.url,
        listIds,
        cards: existingMapping?.cards ?? [],
      };
      this.saveMapping(projectPath, mapping);

      // Initial outbound sync: push existing local items to Trello
      await this.syncOutbound(channelId, projectPath);

      // Wire up fs.watch for outbound sync (debounced)
      this.wireOutboundWatcher(channelId, projectPath);

      this.logger.info('Trello sync initialized for project', {
        projectName,
        boardUrl: board.url,
        boardId: board.id,
      });
    } catch (error) {
      this.logger.error('Failed to initialize Trello sync for project', { projectName, error });
    }
  }

  /**
   * Start the inbound polling loop across all projects.
   */
  startPolling(): void {
    if (this.pollTimer) return;

    const intervalMs = this.config.trello.pollIntervalMs;
    this.logger.info('Starting Trello inbound poll', { intervalMs });

    this.pollTimer = setInterval(() => {
      this.pollAllProjects().catch(err => {
        this.logger.error('Error during Trello poll', { error: err });
      });
    }, intervalMs);
  }

  /**
   * Stop polling and clean up all resources.
   */
  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    for (const timer of this.outboundTimers.values()) {
      clearTimeout(timer);
    }
    this.outboundTimers.clear();

    this.outboundInFlight.clear();

    for (const store of this.stores.values()) {
      store.dispose();
    }
    this.stores.clear();

    this.recentOutboundSyncs.clear();
    this.logger.info('Trello sync disposed');
  }

  // ---------------------------------------------------------------------------
  // Clarification Comments
  // ---------------------------------------------------------------------------

  /**
   * Post a clarification comment on a Trello card and track the comment ID.
   * Called when a task moves to clarification_needed with questions.
   */
  async postClarificationComment(projectPath: string, itemId: string, questions: string[]): Promise<void> {
    const mapping = this.loadMapping(projectPath);
    if (!mapping) return;

    const cardMapping = mapping.cards.find(c => c.localId === itemId);
    if (!cardMapping) {
      this.logger.warn('Cannot post clarification comment: no card mapping', { itemId });
      return;
    }

    const commentText = `🤖 **Clarification Needed**\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n_Reply to this comment with your answers._`;

    const result = await this.trelloFetch<{ id: string }>('POST', `/cards/${cardMapping.trelloCardId}/actions/comments`, {
      text: commentText,
    });

    if (result) {
      cardMapping.clarificationCommentId = result.id;
      this.saveMapping(projectPath, mapping);
      this.logger.info('Posted clarification comment on Trello card', {
        itemId,
        cardId: cardMapping.trelloCardId,
        commentId: result.id,
      });
    }
  }

  /**
   * Check for user replies to clarification comments on cards in clarification_needed status.
   * Called during inbound polling.
   */
  private async pollClarificationReplies(channelId: string, projectPath: string): Promise<void> {
    if (!this.clarificationReplyCallback) return;

    const mapping = this.loadMapping(projectPath);
    if (!mapping) return;

    const store = this.getOrCreateStore(channelId, projectPath);
    const items = store.getItems();

    // Find items waiting for clarification that have a tracked comment
    const waitingItems = items.filter(
      i => i.status === 'clarification_needed' &&
        mapping.cards.find(c => c.localId === i.id && c.clarificationCommentId)
    );

    for (const item of waitingItems) {
      const cardMapping = mapping.cards.find(c => c.localId === item.id)!;
      if (!cardMapping.clarificationCommentId) continue;

      // Fetch recent comments on the card
      const comments = await this.trelloFetch<TrelloComment[]>(
        'GET',
        `/cards/${cardMapping.trelloCardId}/actions?filter=commentCard&limit=10`,
      );

      if (!comments || comments.length === 0) continue;

      // Find comments that came AFTER the bot's clarification comment.
      // Comments are returned newest-first. The bot's comment has a known ID.
      // Any comment newer than the bot's comment that wasn't posted by the bot is a user reply.
      const botCommentIdx = comments.findIndex(c => c.id === cardMapping.clarificationCommentId);

      // All comments before the bot comment index (i.e., newer) are potential replies
      const userReplies = botCommentIdx === -1
        ? [] // Bot comment not found in recent comments (too old or deleted)
        : comments.slice(0, botCommentIdx).filter(c => {
          // Exclude comments that start with the bot's emoji marker
          return !c.data.text.startsWith('🤖');
        });

      if (userReplies.length > 0) {
        // Combine all user replies into a single answer
        const answerText = userReplies
          .reverse() // oldest first
          .map(c => c.data.text)
          .join('\n\n');

        this.logger.info('Detected Trello clarification reply', {
          itemId: item.id,
          cardId: cardMapping.trelloCardId,
          replyCount: userReplies.length,
        });

        // Clear the clarification comment tracking
        cardMapping.clarificationCommentId = undefined;
        this.saveMapping(projectPath, mapping);

        // Fire the callback
        try {
          this.clarificationReplyCallback(channelId, item.id, answerText, projectPath);
        } catch (err) {
          this.logger.error('Error in clarification reply callback', { error: err });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Trello API Client
  // ---------------------------------------------------------------------------

  private async trelloFetch<T = any>(
    method: string,
    endpoint: string,
    body?: Record<string, any>,
  ): Promise<T | null> {
    const url = new URL(`${TRELLO_API_BASE}${endpoint}`);
    url.searchParams.set('key', this.config.trello.apiKey);
    url.searchParams.set('token', this.config.trello.token);

    const options: any = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url.toString(), options);

      if (response.status === 429) {
        this.logger.warn('Trello API rate limited, will retry next cycle');
        return null;
      }

      if (!response.ok) {
        const text = await response.text();
        this.logger.warn('Trello API error', {
          method,
          endpoint,
          status: response.status,
          body: text.slice(0, 200),
        });
        return null;
      }

      // DELETE returns no body - return empty object to distinguish from error null
      if (method === 'DELETE') return {} as T;

      return (await response.json()) as T;
    } catch (error) {
      this.logger.warn('Trello API request failed', { method, endpoint, error });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Board & List Management
  // ---------------------------------------------------------------------------

  private async findOrCreateBoard(boardName: string): Promise<TrelloBoard | null> {
    // Search existing boards for a match
    const boards = await this.trelloFetch<TrelloBoard[]>('GET', '/members/me/boards?filter=open');
    if (!boards) {
      // API call failed - do NOT create a new board, as the existing one
      // may exist but we just couldn't fetch the list. Creating a new board
      // here would produce duplicates.
      this.logger.warn('Failed to fetch Trello boards list, skipping board creation to avoid duplicates', { boardName });
      return null;
    }

    const existing = boards.find(b => b.name === boardName);
    if (existing) {
      this.logger.info('Found existing Trello board', { name: boardName, id: existing.id });
      return existing;
    }

    // Board list fetched successfully but no match found - safe to create
    const newBoard = await this.trelloFetch<TrelloBoard>('POST', '/boards', {
      name: boardName,
      defaultLists: false,
    });

    if (newBoard) {
      this.logger.info('Created new Trello board', { name: boardName, id: newBoard.id });
    }

    return newBoard;
  }

  private async ensureLists(boardId: string): Promise<Record<TaskStatus, string> | null> {
    // Get existing lists on the board
    const existingLists = await this.trelloFetch<TrelloList[]>('GET', `/boards/${boardId}/lists?filter=open`);
    if (!existingLists) return null;

    const existingByName = new Map<string, TrelloList>();
    for (const list of existingLists) {
      existingByName.set(list.name, list);
    }

    const listIds: Partial<Record<TaskStatus, string>> = {};

    // Create lists in order, matching our column order
    for (let i = 0; i < TASK_STATUSES.length; i++) {
      const status = TASK_STATUSES[i];
      const listName = STATUS_TO_LIST_NAME[status];
      const existing = existingByName.get(listName);

      if (existing) {
        listIds[status] = existing.id;
      } else {
        // Create the list with a position that maintains order
        const newList = await this.trelloFetch<TrelloList>('POST', '/lists', {
          name: listName,
          idBoard: boardId,
          pos: (i + 1) * 1024, // Trello uses numeric positions
        });

        if (!newList) {
          this.logger.error('Failed to create Trello list', { listName, boardId });
          return null;
        }

        listIds[status] = newList.id;
      }
    }

    return listIds as Record<TaskStatus, string>;
  }

  // ---------------------------------------------------------------------------
  // Mapping Persistence
  // ---------------------------------------------------------------------------

  private getMappingPath(projectPath: string): string {
    return path.join(projectPath, '.tasks', 'trello-mapping.json');
  }

  private loadMapping(projectPath: string): TrelloMapping | null {
    const mappingPath = this.getMappingPath(projectPath);
    try {
      if (!fs.existsSync(mappingPath)) return null;
      const content = fs.readFileSync(mappingPath, 'utf-8');
      return JSON.parse(content) as TrelloMapping;
    } catch (error) {
      this.logger.warn('Failed to load Trello mapping', { projectPath, error });
      return null;
    }
  }

  private saveMapping(projectPath: string, mapping: TrelloMapping): void {
    const mappingPath = this.getMappingPath(projectPath);
    const dir = path.dirname(mappingPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2), 'utf-8');
  }

  // ---------------------------------------------------------------------------
  // Hashing
  // ---------------------------------------------------------------------------

  private hashItem(title: string, description: string, status: string): string {
    // Always strip the local ID footer before hashing so that outbound hashes
    // match inbound hashes (hashCard also strips it).
    const desc = this.stripLocalIdFooter(description);
    const data = `${title}|${desc}|${status}`;
    return crypto.createHash('md5').update(data).digest('hex');
  }

  private hashCard(card: TrelloCard, listIdToStatus: Map<string, TaskStatus>): string {
    const status = listIdToStatus.get(card.idList) || 'backlog';
    // Strip the "Local ID: #N" footer from description before hashing
    const desc = this.stripLocalIdFooter(card.desc || '');
    return crypto.createHash('md5').update(`${card.name}|${desc}|${status}`).digest('hex');
  }

  // ---------------------------------------------------------------------------
  // Card Description Formatting
  // ---------------------------------------------------------------------------

  private formatCardDescription(item: TaskItem): string {
    const parts: string[] = [];

    if (item.description) {
      parts.push(item.description);
    }

    if (item.acceptanceCriteria && item.acceptanceCriteria.length > 0) {
      parts.push('');
      parts.push('**Acceptance Criteria:**');
      for (const ac of item.acceptanceCriteria) {
        parts.push(`- [ ] ${ac}`);
      }
    }

    if (item.questions && item.questions.length > 0) {
      parts.push('');
      parts.push('**Questions:**');
      for (const q of item.questions) {
        parts.push(`- ${q}`);
      }
    }

    if (item.source || item.assignee || item.executingAgent) {
      parts.push('');
      if (item.source) parts.push(`Source: ${item.source}`);
      if (item.assignee) parts.push(`Assignee: ${item.assignee}`);
      if (item.executingAgent) parts.push(`Executing: ${item.executingAgent}`);
    }

    // Always add a local ID footer for recovery
    parts.push('');
    parts.push(`---`);
    parts.push(`Local ID: #${item.id}`);

    return parts.join('\n');
  }

  private stripLocalIdFooter(desc: string): string {
    // Remove the "---\nLocal ID: #N" footer we add
    return desc.replace(/\n---\nLocal ID: #\d+\s*$/, '').trim();
  }

  private extractLocalIdFromDesc(desc: string): string | null {
    const match = desc.match(/Local ID: #(\d+)\s*$/);
    return match ? match[1] : null;
  }

  // ---------------------------------------------------------------------------
  // Outbound Sync (Local -> Trello)
  // ---------------------------------------------------------------------------

  private wireOutboundWatcher(channelId: string, projectPath: string): void {
    const store = this.getOrCreateStore(channelId, projectPath);

    store.onChanged(() => {
      // Debounce outbound syncs by 2 seconds
      const existingTimer = this.outboundTimers.get(channelId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        this.outboundTimers.delete(channelId);
        this.syncOutbound(channelId, projectPath).catch(err => {
          this.logger.error('Error in outbound sync', { channelId, error: err });
        });
      }, OUTBOUND_DEBOUNCE_MS);

      this.outboundTimers.set(channelId, timer);
    });
  }

  async syncOutbound(channelId: string, projectPath: string): Promise<void> {
    // Skip outbound sync while inbound sync is running to avoid race conditions
    // where the mapping hasn't been saved yet for newly created items.
    if (this.isSyncing) {
      this.logger.debug('Skipping outbound sync - inbound sync in progress', { channelId });
      return;
    }

    // Prevent concurrent outbound syncs for the same channel.
    // Without this, two interleaved async outbound syncs could both see the
    // same unmapped items and create duplicate Trello cards.
    if (this.outboundInFlight.has(channelId)) {
      this.logger.debug('Skipping outbound sync - already in flight', { channelId });
      return;
    }

    this.outboundInFlight.add(channelId);
    try {
      await this.syncOutboundInner(channelId, projectPath);
    } finally {
      this.outboundInFlight.delete(channelId);
    }
  }

  private async syncOutboundInner(channelId: string, projectPath: string): Promise<void> {
    const mapping = this.loadMapping(projectPath);
    if (!mapping) return;

    const store = this.getOrCreateStore(channelId, projectPath);
    const items = store.getItems();

    // Build a set of local IDs for deletion detection
    const localIds = new Set(items.map(i => i.id));

    let mappingChanged = false;

    // Sync each local item to Trello
    for (const item of items) {
      const existingCard = mapping.cards.find(c => c.localId === item.id);
      const localHash = this.hashItem(item.title, this.formatCardDescription(item), item.status);

      if (!existingCard) {
        // New item: create card on Trello
        const listId = mapping.listIds[item.status];
        if (!listId) continue;

        const card = await this.trelloFetch<TrelloCard>('POST', '/cards', {
          name: item.title,
          desc: this.formatCardDescription(item),
          idList: listId,
        });

        if (card) {
          mapping.cards.push({
            localId: item.id,
            trelloCardId: card.id,
            lastSyncedAt: new Date().toISOString(),
            lastLocalHash: localHash,
            lastTrelloHash: localHash,
          });
          this.recordOutboundSync(card.id);
          // Save mapping immediately after each card creation so concurrent
          // or subsequent syncs see the new mapping entry.
          this.saveMapping(projectPath, mapping);
          mappingChanged = false; // already saved
        }
      } else if (localHash !== existingCard.lastLocalHash) {
        // Changed locally: update card on Trello
        const listId = mapping.listIds[item.status];
        if (!listId) continue;

        await this.trelloFetch('PUT', `/cards/${existingCard.trelloCardId}`, {
          name: item.title,
          desc: this.formatCardDescription(item),
          idList: listId,
        });

        existingCard.lastLocalHash = localHash;
        existingCard.lastTrelloHash = localHash;
        existingCard.lastSyncedAt = new Date().toISOString();
        this.recordOutboundSync(existingCard.trelloCardId);
        mappingChanged = true;
      }
      // else: unchanged, skip
    }

    // Items deleted locally: delete cards on Trello
    const toRemove: string[] = [];
    for (const cardMapping of mapping.cards) {
      if (!localIds.has(cardMapping.localId)) {
        const result = await this.trelloFetch('DELETE', `/cards/${cardMapping.trelloCardId}`);
        if (result !== null) {
          toRemove.push(cardMapping.localId);
          mappingChanged = true;
        } else {
          this.logger.warn('Failed to delete Trello card, keeping mapping for retry', {
            trelloCardId: cardMapping.trelloCardId,
            localId: cardMapping.localId,
          });
        }
      }
    }
    if (toRemove.length > 0) {
      mapping.cards = mapping.cards.filter(c => !toRemove.includes(c.localId));
    }

    if (mappingChanged) {
      this.saveMapping(projectPath, mapping);
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound Sync (Trello -> Local)
  // ---------------------------------------------------------------------------

  private async pollAllProjects(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      // Clean up expired echo entries
      this.cleanEchoWindow();

      const projects = this.projectConfig.getAll();
      this.logger.debug('Trello inbound poll running', { projectCount: projects.length });
      for (const project of projects) {
        try {
          await this.syncInbound(project.channelId, project.projectPath);
          // Check for user replies to clarification comments on Trello cards
          await this.pollClarificationReplies(project.channelId, project.projectPath);
        } catch (error) {
          this.logger.warn('Error syncing inbound for project', {
            projectName: project.projectName,
            error,
          });
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  async syncInbound(channelId: string, projectPath: string): Promise<void> {
    const mapping = this.loadMapping(projectPath);
    if (!mapping) return;

    // Fetch all cards from the Trello board
    const cards = await this.trelloFetch<TrelloCard[]>(
      'GET',
      `/boards/${mapping.boardId}/cards?filter=open`,
    );
    if (!cards) return;

    const store = this.getOrCreateStore(channelId, projectPath);

    // Build reverse lookup: listId -> status
    const listIdToStatus = new Map<string, TaskStatus>();
    for (const [status, listId] of Object.entries(mapping.listIds)) {
      listIdToStatus.set(listId, status as TaskStatus);
    }

    // Build set of Trello card IDs for deletion detection
    const trelloCardIds = new Set(cards.map(c => c.id));

    let mappingChanged = false;

    for (const card of cards) {
      const newStatus = listIdToStatus.get(card.idList) || 'backlog';

      // Skip cards in echo window (we just pushed them)
      if (this.isInEchoWindow(card.id)) {
        this.logger.debug('Skipping card in echo window', { cardId: card.id, name: card.name, status: newStatus });
        continue;
      }

      const existingMapping = mapping.cards.find(c => c.trelloCardId === card.id);
      const trelloHash = this.hashCard(card, listIdToStatus);

      if (!existingMapping) {
        // New card created on Trello: create local item
        // Check if there's a Local ID in the description (recovery case)
        const recoveredId = this.extractLocalIdFromDesc(card.desc || '');
        const existingItems = store.getItems();
        const alreadyExists = recoveredId && existingItems.find(i => i.id === recoveredId);

        if (alreadyExists) {
          // Recovered: add the mapping
          mapping.cards.push({
            localId: alreadyExists.id,
            trelloCardId: card.id,
            lastSyncedAt: new Date().toISOString(),
            lastLocalHash: trelloHash,
            lastTrelloHash: trelloHash,
          });
          // Save mapping immediately so outbound sync doesn't create duplicates
          this.saveMapping(projectPath, mapping);
          mappingChanged = true;

          // If the Trello card's status differs from the local item, update
          // local and fire the transition callback so the bot can act on it
          // (e.g., start implementation for "ready" cards).
          if (alreadyExists.status !== newStatus && this.statusTransitionCallback) {
            const oldStatus = alreadyExists.status;
            store.updateItem(alreadyExists.id, { status: newStatus });
            this.logger.info('Firing status transition for recovered card', {
              channelId, itemId: alreadyExists.id, oldStatus, newStatus, cardName: card.name,
            });
            try {
              this.statusTransitionCallback(channelId, alreadyExists.id, oldStatus, newStatus, projectPath);
            } catch (err) {
              this.logger.error('Error in status transition callback (recovered card)', { error: err });
            }
          }
          continue;
        }

        // Create new local item
        const strippedDesc = this.stripLocalIdFooter(card.desc || '');
        const newItem = store.addItem({
          title: card.name,
          description: strippedDesc || undefined,
          status: newStatus,
          source: 'user', // Created externally
        });

        mapping.cards.push({
          localId: newItem.id,
          trelloCardId: card.id,
          lastSyncedAt: new Date().toISOString(),
          lastLocalHash: trelloHash,
          lastTrelloHash: trelloHash,
        });
        // Save mapping immediately after adding a new item.
        // store.addItem() writes to board.json which triggers the outbound watcher;
        // if we defer saving the mapping, outbound sync may find the item without
        // a mapping and create a duplicate card on Trello.
        this.saveMapping(projectPath, mapping);
        mappingChanged = true;

        // Fire status transition callback for new cards at non-backlog statuses
        // so the bot can act on them (e.g., start implementation for "ready" cards).
        // The effective "old status" is backlog since the item didn't exist before.
        if (newStatus !== 'backlog' && this.statusTransitionCallback) {
          this.logger.info('Firing status transition for new card', {
            channelId, itemId: newItem.id, oldStatus: 'backlog', newStatus, cardName: card.name,
          });
          try {
            this.statusTransitionCallback(channelId, newItem.id, 'backlog', newStatus, projectPath);
          } catch (err) {
            this.logger.error('Error in status transition callback (new card)', { error: err });
          }
        }
      } else if (trelloHash !== existingMapping.lastTrelloHash) {
        // Card changed on Trello: update local item
        const localItem = store.getItems().find(i => i.id === existingMapping.localId);
        if (!localItem) continue;

        const oldStatus = localItem.status;
        const strippedDesc = this.stripLocalIdFooter(card.desc || '');

        // Only update title/description if they actually changed on Trello.
        // The card description on Trello is the formatted output of formatCardDescription(),
        // which includes AC, questions, etc. We must NOT write that back into item.description
        // (which is the raw description field), or it will cause description corruption and
        // an infinite sync loop.
        const updates: Partial<typeof localItem> = {};

        // CRITICAL: Do NOT update status if an agent is currently executing this task.
        // The executing agent (slack-bot or claude-code) is responsible for status transitions.
        // If we overwrite the status here, we could revert agent-made changes before they
        // sync to Trello, causing tasks to get "stuck" in planning when they should be
        // in ready/clarification_needed.
        if (!localItem.executingAgent) {
          if (oldStatus !== newStatus) {
            updates.status = newStatus;
          }
        } else {
          this.logger.debug('Skipping status update for agent-claimed item', {
            itemId: localItem.id,
            executingAgent: localItem.executingAgent,
            localStatus: oldStatus,
            trelloStatus: newStatus,
          });
        }

        if (card.name !== localItem.title) {
          updates.title = card.name;
        }

        // Compare the stripped Trello description against what we would have formatted.
        // Only update if the user actually edited the description on Trello.
        const expectedDesc = this.stripLocalIdFooter(this.formatCardDescription(localItem));
        if (strippedDesc !== expectedDesc) {
          updates.description = strippedDesc || undefined;
        }

        // Only update if there are changes to apply
        if (Object.keys(updates).length > 0) {
          store.updateItem(localItem.id, updates);
        }

        existingMapping.lastTrelloHash = trelloHash;
        // Only update lastLocalHash to match Trello if we actually applied
        // the status change locally. If we skipped the status update (because
        // executingAgent was set), keep lastLocalHash at the current local value
        // so the outbound sync doesn't push stale local status back to Trello.
        if (!localItem.executingAgent || oldStatus === newStatus) {
          existingMapping.lastLocalHash = trelloHash;
        } else {
          // Recompute local hash from current local state to prevent outbound
          // sync from reverting the Trello status
          existingMapping.lastLocalHash = this.hashItem(
            localItem.title,
            this.formatCardDescription(localItem),
            localItem.status,
          );
        }
        existingMapping.lastSyncedAt = new Date().toISOString();
        mappingChanged = true;

        // Fire status transition callback if status changed
        if (oldStatus !== newStatus && this.statusTransitionCallback) {
          this.logger.info('Firing status transition callback', {
            channelId, itemId: localItem.id, oldStatus, newStatus, cardName: card.name,
          });
          try {
            this.statusTransitionCallback(channelId, localItem.id, oldStatus, newStatus, projectPath);
          } catch (err) {
            this.logger.error('Error in Trello status transition callback', { error: err });
          }
        } else if (oldStatus !== newStatus) {
          this.logger.warn('Status changed but no callback registered', {
            channelId, itemId: localItem.id, oldStatus, newStatus,
          });
        }
      } else if (existingMapping) {
        // Hash matches — card unchanged on Trello
        if (newStatus === 'ready' || newStatus === 'in_progress' || newStatus === 'planning') {
          this.logger.debug('Card unchanged (hash match)', {
            cardId: card.id, name: card.name, status: newStatus, localId: existingMapping.localId,
          });
        }
      }
    }

    // Cards deleted on Trello: delete local items
    const toRemove: string[] = [];
    for (const cardMapping of mapping.cards) {
      if (!trelloCardIds.has(cardMapping.trelloCardId)) {
        // Card was deleted on Trello, or archived (closed cards not in open filter)
        store.deleteItem(cardMapping.localId);
        toRemove.push(cardMapping.trelloCardId);
        mappingChanged = true;
      }
    }
    if (toRemove.length > 0) {
      mapping.cards = mapping.cards.filter(c => !toRemove.includes(c.trelloCardId));
    }

    if (mappingChanged) {
      this.saveMapping(projectPath, mapping);
    }
  }

  // ---------------------------------------------------------------------------
  // Echo Prevention
  // ---------------------------------------------------------------------------

  private recordOutboundSync(trelloCardId: string): void {
    this.recentOutboundSyncs.set(trelloCardId, Date.now());
    // Prevent unbounded growth - clean stale entries periodically
    if (this.recentOutboundSyncs.size > 100) {
      this.cleanEchoWindow();
    }
  }

  private isInEchoWindow(trelloCardId: string): boolean {
    const timestamp = this.recentOutboundSyncs.get(trelloCardId);
    if (!timestamp) return false;
    return Date.now() - timestamp < ECHO_WINDOW_MS;
  }

  private cleanEchoWindow(): void {
    const now = Date.now();
    for (const [cardId, timestamp] of this.recentOutboundSyncs) {
      if (now - timestamp >= ECHO_WINDOW_MS) {
        this.recentOutboundSyncs.delete(cardId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Store Management
  // ---------------------------------------------------------------------------

  private getOrCreateStore(channelId: string, projectPath: string): BoardStore {
    let store = this.stores.get(channelId);
    if (store) return store;

    store = new BoardStore(projectPath);
    this.stores.set(channelId, store);
    return store;
  }
}
