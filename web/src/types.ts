export type KanbanStatus =
  | 'backlog'
  | 'clarification_needed'
  | 'planning'
  | 'ready'
  | 'in_progress'
  | 'review'
  | 'done';

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

export interface BoardColumn {
  id: KanbanStatus;
  label: string;
  color: string;
}

export interface BoardData {
  version: 1;
  projectName: string;
  columns: BoardColumn[];
  items: KanbanItem[];
  nextId: number;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  channelName: string;
  projectPath: string;
  projectName: string;
  itemCount: number;
  statusCounts: Record<string, number>;
}
