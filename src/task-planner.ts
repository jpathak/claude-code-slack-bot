import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger.js';
import { BoardStore } from './board-store.js';
import { TaskItem, BoardData, TaskStatus, TASK_STATUSES } from './types.js';

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  clarification_needed: 'Clarification Needed',
  planning: 'Planning',
  ready: 'Ready to Execute',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

export class TaskPlanner {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('TaskPlanner');
  }

  /**
   * Get the specs directory for a task within a project.
   * Creates the directory if it doesn't exist.
   */
  getSpecsDir(projectPath: string, taskId: string): string {
    const specsDir = path.join(projectPath, '.specs', taskId);
    if (!fs.existsSync(specsDir)) {
      fs.mkdirSync(specsDir, { recursive: true });
    }
    return specsDir;
  }

  /**
   * Write a spec file for a task.
   */
  writeSpec(projectPath: string, taskId: string, filename: string, content: string): string {
    const specsDir = this.getSpecsDir(projectPath, taskId);
    const filePath = path.join(specsDir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    this.logger.info('Wrote spec file', { taskId, filename, path: filePath });
    return filePath;
  }

  /**
   * Read a spec file for a task. Returns null if not found.
   */
  readSpec(projectPath: string, taskId: string, filename: string): string | null {
    const filePath = path.join(projectPath, '.specs', taskId, filename);
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Save the planning output as a spec document for the task.
   */
  savePlanSpec(projectPath: string, item: TaskItem, planningOutput: string): string {
    const content = [
      `# Task #${item.id}: ${item.title}`,
      '',
      item.description ? `## Description\n${item.description}\n` : '',
      planningOutput,
      '',
      `---`,
      `Generated: ${new Date().toISOString()}`,
      `Status: ${item.status}`,
    ].filter(Boolean).join('\n');

    return this.writeSpec(projectPath, item.id, 'plan.md', content);
  }

  /**
   * Save implementation notes as a spec document.
   */
  saveImplementationSpec(projectPath: string, item: TaskItem, output: string): string {
    const content = [
      `# Implementation: Task #${item.id} - ${item.title}`,
      '',
      output,
      '',
      `---`,
      `Completed: ${new Date().toISOString()}`,
    ].join('\n');

    return this.writeSpec(projectPath, item.id, 'implementation.md', content);
  }

  /**
   * Generate a planning prompt that instructs Claude to analyze a task
   * and produce acceptance criteria, questions, and subtasks.
   */
  generatePlanningPrompt(item: TaskItem, projectPath?: string): string {
    const descriptionBlock = item.description
      ? `\nDescription: ${item.description}`
      : '';

    // Include existing spec context if available
    let specContext = '';
    if (projectPath) {
      const existingPlan = this.readSpec(projectPath, item.id, 'plan.md');
      if (existingPlan) {
        specContext = `\n\nExisting spec context:\n${existingPlan}\n`;
      }
    }

    const specsNote = projectPath
      ? `\n\nNote: Your planning output will be saved to ${path.join(projectPath, '.specs', item.id, 'plan.md')}`
      : '';

    return [
      `You are planning task #${item.id}: "${item.title}"${descriptionBlock}${specContext}`,
      '',
      'Analyze this task and produce a structured plan. Your output MUST use the exact section headers below.',
      '',
      '## Acceptance Criteria',
      'List 3-7 testable, specific acceptance criteria. Each must be a concrete, verifiable condition.',
      'Use the format: - [ ] <criterion>',
      '',
      '## Questions',
      'List any questions that need to be answered before implementation can begin.',
      'If the task is clear enough to proceed without clarification, write: - None',
      'Use the format: - <question>',
      '',
      '## Subtasks',
      'If the task is large, break it into smaller implementation subtasks.',
      'If the task is small enough to implement in one step, write: - None',
      'Use the format: - <subtask>',
      specsNote,
    ].join('\n');
  }

  /**
   * Generate an implementation prompt for a task that includes its spec context.
   */
  generateImplementationPrompt(item: TaskItem, projectPath: string): string {
    const acSection = item.acceptanceCriteria?.length
      ? '\n\nAcceptance Criteria:\n' + item.acceptanceCriteria.map(ac => `- [ ] ${ac}`).join('\n')
      : '';
    const descSection = item.description ? `\n\nDescription: ${item.description}` : '';

    // Include spec context
    const planSpec = this.readSpec(projectPath, item.id, 'plan.md');
    const specSection = planSpec
      ? `\n\nPlanning Spec (from .specs/${item.id}/plan.md):\n${planSpec}`
      : '';

    return [
      `Implement task #${item.id}: "${item.title}"`,
      descSection,
      acSection,
      specSection,
      '',
      'Please implement this task fully. When done:',
      '1. Provide a summary of what was changed',
      '2. Verify against each acceptance criterion',
      `3. Your implementation notes will be saved to .specs/${item.id}/implementation.md`,
    ].join('\n');
  }

  /**
   * Generate a retry implementation prompt when a task is moved back from review to in_progress.
   * Includes the previous implementation notes so Claude knows what was already tried.
   */
  generateRetryImplementationPrompt(item: TaskItem, projectPath: string): string {
    const acSection = item.acceptanceCriteria?.length
      ? '\n\nAcceptance Criteria:\n' + item.acceptanceCriteria.map(ac => `- [ ] ${ac}`).join('\n')
      : '';
    const descSection = item.description ? `\n\nDescription: ${item.description}` : '';

    // Include spec context
    const planSpec = this.readSpec(projectPath, item.id, 'plan.md');
    const specSection = planSpec
      ? `\n\nPlanning Spec (from .specs/${item.id}/plan.md):\n${planSpec}`
      : '';

    // Include previous implementation notes
    const implSpec = this.readSpec(projectPath, item.id, 'implementation.md');
    const prevImplSection = implSpec
      ? `\n\n--- PREVIOUS IMPLEMENTATION ATTEMPT ---\nThe following implementation was attempted but moved back from review because it did not fully work:\n\n${implSpec}\n--- END PREVIOUS ATTEMPT ---`
      : '';

    return [
      `RETRY implementation of task #${item.id}: "${item.title}"`,
      '',
      'IMPORTANT: This task was previously implemented but the result was not satisfactory.',
      'It has been moved back from Review to In Progress, which means the previous approach had issues.',
      'You MUST:',
      '1. Read the previous implementation attempt below to understand what was already tried',
      '2. Investigate what went wrong with the previous approach',
      '3. Take a different or deeper approach to fix the remaining issues',
      '4. Do NOT simply repeat the same changes',
      descSection,
      acSection,
      specSection,
      prevImplSection,
      '',
      'When done:',
      '1. Explain what was wrong with the previous attempt',
      '2. Describe what you changed and why this approach is better',
      '3. Verify against each acceptance criterion',
      `4. Your updated implementation notes will be saved to .specs/${item.id}/implementation.md`,
    ].join('\n');
  }

  /**
   * Parse Claude's planning output to extract acceptance criteria, questions, and subtasks.
   */
  parsePlanningOutput(output: string): {
    acceptanceCriteria: string[];
    questions: string[];
    subtasks: string[];
  } {
    const result = {
      acceptanceCriteria: [] as string[],
      questions: [] as string[],
      subtasks: [] as string[],
    };

    const sections = this.splitIntoSections(output);

    for (const section of sections) {
      const heading = section.heading.toLowerCase();
      const items = this.parseListItems(section.body);

      if (heading.includes('acceptance criteria')) {
        result.acceptanceCriteria = items;
      } else if (heading.includes('question')) {
        result.questions = items;
      } else if (heading.includes('subtask')) {
        result.subtasks = items;
      }
    }

    return result;
  }

  /**
   * Generate a board context string to inject into Claude's system prompt.
   */
  generateBoardContext(boardData: BoardData): string {
    const lines: string[] = [
      '=== Current Board State ===',
      `Project: ${boardData.projectName}`,
      '',
    ];

    for (const status of TASK_STATUSES) {
      const items = boardData.items.filter(i => i.status === status);
      lines.push(`${STATUS_LABELS[status]} (${items.length}):`);

      for (const item of items) {
        let detail = `  #${item.id} - ${item.title}`;

        if (status === 'clarification_needed' && item.questions && item.questions.length > 0) {
          detail += ` (${item.questions.length} question${item.questions.length === 1 ? '' : 's'} pending)`;
        }

        if (status === 'planning' && item.acceptanceCriteria && item.acceptanceCriteria.length > 0) {
          detail += ` (${item.acceptanceCriteria.length} acceptance criteria)`;
        }

        lines.push(detail);
      }

      lines.push('');
    }

    lines.push('===');
    return lines.join('\n');
  }

  /**
   * Process a task for planning. Does NOT move the task (caller handles that).
   * Generates the planning prompt for the item.
   */
  async processNewTask(
    store: BoardStore,
    itemId: string,
  ): Promise<{ planningPrompt: string; item: TaskItem } | null> {
    const item = store.findItem(itemId);
    if (!item) {
      this.logger.warn('processNewTask: item not found', { itemId });
      return null;
    }

    // Ensure it's in planning status
    let currentItem = item;
    if (item.status !== 'planning') {
      const movedItem = store.moveItem(item.id, 'planning');
      if (!movedItem) {
        this.logger.error('processNewTask: failed to move item to planning', { itemId: item.id });
        return null;
      }
      currentItem = movedItem;
    }

    this.logger.info('Processing task for planning', { itemId: currentItem.id, title: currentItem.title });

    const planningPrompt = this.generatePlanningPrompt(currentItem, store.getProjectPath());
    return { planningPrompt, item: currentItem };
  }

  /**
   * Apply Claude's planning output to a task.
   * Saves the plan as a spec, sets AC and questions on the item.
   */
  async applyPlanningResult(
    store: BoardStore,
    itemId: string,
    output: string,
  ): Promise<TaskItem | null> {
    const item = store.findItem(itemId);
    if (!item) {
      this.logger.warn('applyPlanningResult: item not found', { itemId });
      return null;
    }

    const parsed = this.parsePlanningOutput(output);

    // Save the plan spec to disk
    this.savePlanSpec(store.getProjectPath(), item, output);

    const updates: Partial<TaskItem> = {};

    if (parsed.acceptanceCriteria.length > 0) {
      updates.acceptanceCriteria = parsed.acceptanceCriteria;
    }

    const hasQuestions = parsed.questions.length > 0;
    if (hasQuestions) {
      updates.questions = parsed.questions;
      updates.status = 'clarification_needed';
      this.logger.info('Task has questions, moving to clarification_needed', {
        itemId: item.id,
        questionCount: parsed.questions.length,
      });
    } else {
      // Planning complete with no questions - move to ready
      updates.status = 'ready';
      this.logger.info('Planning complete, moving to ready', { itemId: item.id });
    }

    const updated = store.updateItem(item.id, updates);
    if (!updated) {
      this.logger.error('applyPlanningResult: failed to update item', { itemId: item.id });
      return null;
    }

    this.logger.info('Applied planning result to task', {
      itemId: updated.id,
      acceptanceCriteriaCount: parsed.acceptanceCriteria.length,
      questionCount: parsed.questions.length,
      subtaskCount: parsed.subtasks.length,
      newStatus: updated.status,
    });

    return updated;
  }

  // --- Private helpers ---

  private splitIntoSections(text: string): Array<{ heading: string; body: string }> {
    const sections: Array<{ heading: string; body: string }> = [];
    const lines = text.split('\n');
    let currentHeading = '';
    let currentBody: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)/);
      if (headingMatch) {
        if (currentHeading) {
          sections.push({ heading: currentHeading, body: currentBody.join('\n') });
        }
        currentHeading = headingMatch[1].trim();
        currentBody = [];
      } else {
        currentBody.push(line);
      }
    }

    if (currentHeading) {
      sections.push({ heading: currentHeading, body: currentBody.join('\n') });
    }

    return sections;
  }

  private parseListItems(body: string): string[] {
    const items: string[] = [];
    const lines = body.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let content: string | null = null;

      const checkboxMatch = trimmed.match(/^[-*]\s+\[[ x]\]\s+(.+)/i);
      if (checkboxMatch) {
        content = checkboxMatch[1].trim();
      }

      if (!content) {
        const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
        if (bulletMatch) {
          content = bulletMatch[1].trim();
        }
      }

      if (!content) {
        const numberedMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
        if (numberedMatch) {
          content = numberedMatch[1].trim();
        }
      }

      if (content && content.toLowerCase() !== 'none') {
        items.push(content);
      }
    }

    return items;
  }
}
