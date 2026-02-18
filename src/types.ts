export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
  /** Whether this session was resumed from an existing CLI/Slack session */
  isResumed?: boolean;
  /** The source of the resumed session */
  resumedFrom?: 'cli' | 'slack';
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}

export type VerbosityLevel = 'minimal' | 'normal' | 'verbose';

export interface VerbosityConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  level: VerbosityLevel;
  setAt: Date;
}

// Project-channel mapping types
export interface ProjectMapping {
  channelId: string;
  channelName: string;
  projectPath: string;
  projectName: string;
  listId: string | null;
  createdAt: string;
  lastSyncedAt: string;
}

// Kanban board types
export const KANBAN_STATUSES = ['backlog', 'clarification_needed', 'planning', 'ready', 'in_progress', 'review', 'done'] as const;
export type KanbanStatus = typeof KANBAN_STATUSES[number];

export interface KanbanItem {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  status: KanbanStatus;
  assignee?: string;
  source: 'claude' | 'user';
  questions?: string[];
  createdAt: string;
  updatedAt: string;
}

export type KanbanCommand =
  | { type: 'board' }
  | { type: 'add'; title: string }
  | { type: 'done'; ref: string }
  | { type: 'move'; ref: string; status: KanbanStatus }
  | { type: 'sync' }
  | { type: 'go'; ref: string }
  | { type: 'answer'; ref: string; response: string }
  | { type: 'approve'; ref: string };

// Board store types (file-backed persistent storage)
export interface BoardColumn {
  id: KanbanStatus;
  label: string;
  color: string;
}

export const DEFAULT_BOARD_COLUMNS: BoardColumn[] = [
  { id: 'backlog', label: 'Backlog', color: '#fef08a' },
  { id: 'clarification_needed', label: 'Clarification Needed', color: '#fdba74' },
  { id: 'planning', label: 'Planning', color: '#93c5fd' },
  { id: 'ready', label: 'Ready to Execute', color: '#67e8f9' },
  { id: 'in_progress', label: 'In Progress', color: '#86efac' },
  { id: 'review', label: 'Review', color: '#c4b5fd' },
  { id: 'done', label: 'Done', color: '#d1d5db' },
];

export interface BoardData {
  version: 1;
  projectName: string;
  columns: BoardColumn[];
  items: KanbanItem[];
  nextId: number;
  updatedAt: string;
}