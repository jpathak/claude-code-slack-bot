import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskPlanner } from './task-planner.js';
import { BoardStore } from './board-store.js';
import { TaskItem, BoardData } from './types.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

function createTempStore(): { store: BoardStore; dir: string } {
  const dir = path.join(os.tmpdir(), `task-planner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return { store: new BoardStore(dir), dir };
}

describe('TaskPlanner', () => {
  let planner: TaskPlanner;
  let store: BoardStore;
  let tempDir: string;

  beforeEach(() => {
    planner = new TaskPlanner();
    const temp = createTempStore();
    store = temp.store;
    tempDir = temp.dir;
  });

  afterEach(() => {
    store.dispose();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  // --- generatePlanningPrompt ---

  describe('generatePlanningPrompt', () => {
    it('should include the task ID and title', () => {
      const item: TaskItem = {
        id: '1',
        title: 'Implement OAuth2 login',
        status: 'backlog',
        source: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const prompt = planner.generatePlanningPrompt(item);

      expect(prompt).toContain('#1');
      expect(prompt).toContain('Implement OAuth2 login');
    });

    it('should include the description when present', () => {
      const item: TaskItem = {
        id: '2',
        title: 'Add caching layer',
        description: 'We need Redis-based caching for the API responses',
        status: 'backlog',
        source: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const prompt = planner.generatePlanningPrompt(item);

      expect(prompt).toContain('Redis-based caching');
    });

    it('should not include a description line when there is none', () => {
      const item: TaskItem = {
        id: '3',
        title: 'Fix bug',
        status: 'backlog',
        source: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const prompt = planner.generatePlanningPrompt(item);

      expect(prompt).not.toContain('Description:');
    });

    it('should instruct Claude to generate acceptance criteria', () => {
      const item: TaskItem = {
        id: '1',
        title: 'Test task',
        status: 'backlog',
        source: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const prompt = planner.generatePlanningPrompt(item);

      expect(prompt).toContain('## Acceptance Criteria');
      expect(prompt).toContain('## Questions');
      expect(prompt).toContain('## Subtasks');
      expect(prompt).toContain('3-7');
      expect(prompt).toContain('testable');
    });
  });

  // --- parsePlanningOutput ---

  describe('parsePlanningOutput', () => {
    it('should parse bullet-point acceptance criteria', () => {
      const output = [
        '## Acceptance Criteria',
        '- [ ] Users can log in with Google OAuth',
        '- [ ] Session tokens are stored securely',
        '- [ ] Logout invalidates the session',
        '',
        '## Questions',
        '- None',
        '',
        '## Subtasks',
        '- None',
      ].join('\n');

      const result = planner.parsePlanningOutput(output);

      expect(result.acceptanceCriteria).toEqual([
        'Users can log in with Google OAuth',
        'Session tokens are stored securely',
        'Logout invalidates the session',
      ]);
      expect(result.questions).toEqual([]);
      expect(result.subtasks).toEqual([]);
    });

    it('should parse questions and subtasks', () => {
      const output = [
        '## Acceptance Criteria',
        '- [ ] API returns paginated results',
        '- [ ] Default page size is 20',
        '',
        '## Questions',
        '- What is the maximum page size?',
        '- Should we support cursor-based pagination?',
        '',
        '## Subtasks',
        '- Implement pagination middleware',
        '- Add pagination params to query builder',
        '- Update API documentation',
      ].join('\n');

      const result = planner.parsePlanningOutput(output);

      expect(result.acceptanceCriteria).toHaveLength(2);
      expect(result.questions).toEqual([
        'What is the maximum page size?',
        'Should we support cursor-based pagination?',
      ]);
      expect(result.subtasks).toEqual([
        'Implement pagination middleware',
        'Add pagination params to query builder',
        'Update API documentation',
      ]);
    });

    it('should handle numbered lists', () => {
      const output = [
        '## Acceptance Criteria',
        '1. Users can upload files up to 50MB',
        '2. Uploaded files are virus-scanned',
        '3. File metadata is stored in the database',
        '',
        '## Questions',
        '1. Which file types should be allowed?',
        '',
        '## Subtasks',
        '1) Create upload endpoint',
        '2) Add virus scanning integration',
      ].join('\n');

      const result = planner.parsePlanningOutput(output);

      expect(result.acceptanceCriteria).toHaveLength(3);
      expect(result.questions).toHaveLength(1);
      expect(result.subtasks).toHaveLength(2);
      expect(result.subtasks[0]).toBe('Create upload endpoint');
    });

    it('should filter out "None" entries', () => {
      const output = [
        '## Acceptance Criteria',
        '- [ ] Feature works correctly',
        '',
        '## Questions',
        '- None',
        '',
        '## Subtasks',
        '- None',
      ].join('\n');

      const result = planner.parsePlanningOutput(output);

      expect(result.acceptanceCriteria).toHaveLength(1);
      expect(result.questions).toEqual([]);
      expect(result.subtasks).toEqual([]);
    });

    it('should handle mixed bullet and checkbox formats', () => {
      const output = [
        '## Acceptance Criteria',
        '- [ ] First criterion',
        '- [x] Already done criterion',
        '- Third criterion without checkbox',
        '',
        '## Questions',
        '- None',
        '',
        '## Subtasks',
        '- None',
      ].join('\n');

      const result = planner.parsePlanningOutput(output);

      expect(result.acceptanceCriteria).toHaveLength(3);
      expect(result.acceptanceCriteria[0]).toBe('First criterion');
      expect(result.acceptanceCriteria[1]).toBe('Already done criterion');
      expect(result.acceptanceCriteria[2]).toBe('Third criterion without checkbox');
    });

    it('should return empty arrays for empty or malformed output', () => {
      const result = planner.parsePlanningOutput('');

      expect(result.acceptanceCriteria).toEqual([]);
      expect(result.questions).toEqual([]);
      expect(result.subtasks).toEqual([]);
    });

    it('should handle output with extra whitespace and blank lines', () => {
      const output = [
        '',
        '## Acceptance Criteria',
        '',
        '  - [ ] Criterion A  ',
        '  - [ ] Criterion B  ',
        '',
        '## Questions',
        '',
        '  - Question 1  ',
        '',
        '## Subtasks',
        '  - None',
        '',
      ].join('\n');

      const result = planner.parsePlanningOutput(output);

      expect(result.acceptanceCriteria).toEqual(['Criterion A', 'Criterion B']);
      expect(result.questions).toEqual(['Question 1']);
      expect(result.subtasks).toEqual([]);
    });

    it('should handle asterisk bullet points', () => {
      const output = [
        '## Acceptance Criteria',
        '* Users can sign up',
        '* Users receive confirmation email',
        '',
        '## Questions',
        '* None',
        '',
        '## Subtasks',
        '* None',
      ].join('\n');

      const result = planner.parsePlanningOutput(output);

      expect(result.acceptanceCriteria).toEqual([
        'Users can sign up',
        'Users receive confirmation email',
      ]);
    });
  });

  // --- generateBoardContext ---

  describe('generateBoardContext', () => {
    it('should include the project name', () => {
      const boardData: BoardData = {
        version: 1,
        projectName: 'my-app',
        columns: [],
        items: [],
        nextId: 1,
        updatedAt: new Date().toISOString(),
      };

      const context = planner.generateBoardContext(boardData);

      expect(context).toContain('Project: my-app');
    });

    it('should show all status columns with counts', () => {
      const boardData: BoardData = {
        version: 1,
        projectName: 'test-project',
        columns: [],
        items: [],
        nextId: 1,
        updatedAt: new Date().toISOString(),
      };

      const context = planner.generateBoardContext(boardData);

      expect(context).toContain('Backlog (0):');
      expect(context).toContain('Clarification Needed (0):');
      expect(context).toContain('Planning (0):');
      expect(context).toContain('Ready to Execute (0):');
      expect(context).toContain('In Progress (0):');
      expect(context).toContain('Review (0):');
      expect(context).toContain('Done (0):');
    });

    it('should list items under their respective columns', () => {
      const now = new Date().toISOString();
      const boardData: BoardData = {
        version: 1,
        projectName: 'test-project',
        columns: [],
        items: [
          { id: '1', title: 'Implement auth', status: 'backlog', source: 'user', createdAt: now, updatedAt: now },
          { id: '2', title: 'Add tests', status: 'backlog', source: 'user', createdAt: now, updatedAt: now },
          { id: '3', title: 'Refactor API', status: 'in_progress', source: 'claude', createdAt: now, updatedAt: now },
          { id: '4', title: 'Setup CI', status: 'done', source: 'user', createdAt: now, updatedAt: now },
        ],
        nextId: 5,
        updatedAt: now,
      };

      const context = planner.generateBoardContext(boardData);

      expect(context).toContain('Backlog (2):');
      expect(context).toContain('#1 - Implement auth');
      expect(context).toContain('#2 - Add tests');
      expect(context).toContain('In Progress (1):');
      expect(context).toContain('#3 - Refactor API');
      expect(context).toContain('Done (1):');
      expect(context).toContain('#4 - Setup CI');
    });

    it('should show question count for clarification_needed items', () => {
      const now = new Date().toISOString();
      const boardData: BoardData = {
        version: 1,
        projectName: 'test-project',
        columns: [],
        items: [
          {
            id: '1',
            title: 'Deploy pipeline',
            status: 'clarification_needed',
            source: 'user',
            questions: ['Which cloud provider?', 'What region?'],
            createdAt: now,
            updatedAt: now,
          },
        ],
        nextId: 2,
        updatedAt: now,
      };

      const context = planner.generateBoardContext(boardData);

      expect(context).toContain('Clarification Needed (1):');
      expect(context).toContain('#1 - Deploy pipeline (2 questions pending)');
    });

    it('should show acceptance criteria count for planning items', () => {
      const now = new Date().toISOString();
      const boardData: BoardData = {
        version: 1,
        projectName: 'test-project',
        columns: [],
        items: [
          {
            id: '5',
            title: 'Add caching',
            status: 'planning',
            source: 'user',
            acceptanceCriteria: ['Cache TTL is configurable', 'Cache invalidation on update', 'Redis cluster support', 'Monitoring metrics exposed'],
            createdAt: now,
            updatedAt: now,
          },
        ],
        nextId: 6,
        updatedAt: now,
      };

      const context = planner.generateBoardContext(boardData);

      expect(context).toContain('Planning (1):');
      expect(context).toContain('#5 - Add caching (4 acceptance criteria)');
    });

    it('should use singular "question" for a single question', () => {
      const now = new Date().toISOString();
      const boardData: BoardData = {
        version: 1,
        projectName: 'test-project',
        columns: [],
        items: [
          {
            id: '1',
            title: 'Task with one question',
            status: 'clarification_needed',
            source: 'user',
            questions: ['Only one question?'],
            createdAt: now,
            updatedAt: now,
          },
        ],
        nextId: 2,
        updatedAt: now,
      };

      const context = planner.generateBoardContext(boardData);

      expect(context).toContain('(1 question pending)');
    });

    it('should be wrapped with === markers', () => {
      const boardData: BoardData = {
        version: 1,
        projectName: 'test',
        columns: [],
        items: [],
        nextId: 1,
        updatedAt: new Date().toISOString(),
      };

      const context = planner.generateBoardContext(boardData);

      expect(context).toMatch(/^=== Current Board State ===/);
      expect(context.trim()).toMatch(/===$/);
    });
  });

  // --- processNewTask ---

  describe('processNewTask', () => {
    it('should move item to planning and return the planning prompt', async () => {
      const item = store.addItem({ title: 'Build authentication', status: 'backlog', source: 'user' });

      const result = await planner.processNewTask(store, item.id);

      expect(result).not.toBeNull();
      expect(result!.item.status).toBe('planning');
      expect(result!.planningPrompt).toContain('Build authentication');
      expect(result!.planningPrompt).toContain(`#${item.id}`);

      // Verify the store was updated
      const reloaded = store.findItem(item.id);
      expect(reloaded!.status).toBe('planning');
    });

    it('should return null for nonexistent item ID', async () => {
      const result = await planner.processNewTask(store, '999');

      expect(result).toBeNull();
    });

    it('should work with items that have a description', async () => {
      const item = store.addItem({
        title: 'Add Redis caching',
        description: 'Cache API responses with 5-minute TTL',
        status: 'backlog',
        source: 'user',
      });

      const result = await planner.processNewTask(store, item.id);

      expect(result).not.toBeNull();
      expect(result!.planningPrompt).toContain('Cache API responses');
    });
  });

  // --- applyPlanningResult ---

  describe('applyPlanningResult', () => {
    it('should set acceptance criteria and move to ready when no questions', async () => {
      const item = store.addItem({ title: 'Simple task', status: 'planning', source: 'user' });

      const output = [
        '## Acceptance Criteria',
        '- [ ] Feature works',
        '- [ ] Tests pass',
        '- [ ] No regressions',
        '',
        '## Questions',
        '- None',
        '',
        '## Subtasks',
        '- None',
      ].join('\n');

      const updated = await planner.applyPlanningResult(store, item.id, output);

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('ready');
      expect(updated!.acceptanceCriteria).toEqual([
        'Feature works',
        'Tests pass',
        'No regressions',
      ]);
      expect(updated!.questions).toBeUndefined();
    });

    it('should move to clarification_needed when questions exist', async () => {
      const item = store.addItem({ title: 'Ambiguous task', status: 'planning', source: 'user' });

      const output = [
        '## Acceptance Criteria',
        '- [ ] API handles pagination',
        '',
        '## Questions',
        '- What is the max page size?',
        '- Should we support cursor pagination?',
        '',
        '## Subtasks',
        '- None',
      ].join('\n');

      const updated = await planner.applyPlanningResult(store, item.id, output);

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('clarification_needed');
      expect(updated!.questions).toEqual([
        'What is the max page size?',
        'Should we support cursor pagination?',
      ]);
      expect(updated!.acceptanceCriteria).toEqual(['API handles pagination']);
    });

    it('should return null for nonexistent item ID', async () => {
      const result = await planner.applyPlanningResult(store, '999', '## Acceptance Criteria\n- [ ] test');

      expect(result).toBeNull();
    });

    it('should handle output with no valid acceptance criteria', async () => {
      const item = store.addItem({ title: 'Edge case', status: 'planning', source: 'user' });

      const output = [
        '## Acceptance Criteria',
        '(some text without list items)',
        '',
        '## Questions',
        '- Need more info',
        '',
        '## Subtasks',
        '- None',
      ].join('\n');

      const updated = await planner.applyPlanningResult(store, item.id, output);

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('clarification_needed');
      expect(updated!.acceptanceCriteria).toBeUndefined();
      expect(updated!.questions).toEqual(['Need more info']);
    });

    it('should persist changes to the store', async () => {
      const item = store.addItem({ title: 'Persistent task', status: 'planning', source: 'user' });

      const output = [
        '## Acceptance Criteria',
        '- [ ] Criterion A',
        '- [ ] Criterion B',
        '',
        '## Questions',
        '- None',
        '',
        '## Subtasks',
        '- None',
      ].join('\n');

      await planner.applyPlanningResult(store, item.id, output);

      // Re-load from store to verify persistence
      const reloaded = store.findItem(item.id);
      expect(reloaded!.acceptanceCriteria).toEqual(['Criterion A', 'Criterion B']);
      expect(reloaded!.status).toBe('ready');
    });

    it('should save plan spec to disk', async () => {
      const item = store.addItem({ title: 'Spec test task', status: 'planning', source: 'user' });

      const output = [
        '## Acceptance Criteria',
        '- [ ] Feature works',
        '',
        '## Questions',
        '- None',
        '',
        '## Subtasks',
        '- None',
      ].join('\n');

      await planner.applyPlanningResult(store, item.id, output);

      // Verify the spec file was saved
      const specContent = planner.readSpec(tempDir, item.id, 'plan.md');
      expect(specContent).not.toBeNull();
      expect(specContent).toContain('Spec test task');
      expect(specContent).toContain('## Acceptance Criteria');
    });
  });

  // --- Spec directory management ---

  describe('getSpecsDir', () => {
    it('should create the specs directory if it does not exist', () => {
      const specsDir = planner.getSpecsDir(tempDir, '42');

      expect(fs.existsSync(specsDir)).toBe(true);
      expect(specsDir).toBe(path.join(tempDir, '.specs', '42'));
    });

    it('should return existing directory without error', () => {
      // Create it twice
      const dir1 = planner.getSpecsDir(tempDir, '10');
      const dir2 = planner.getSpecsDir(tempDir, '10');

      expect(dir1).toBe(dir2);
      expect(fs.existsSync(dir1)).toBe(true);
    });
  });

  describe('writeSpec / readSpec', () => {
    it('should write and read a spec file', () => {
      planner.writeSpec(tempDir, '7', 'notes.md', '# Notes\nSome notes here');

      const content = planner.readSpec(tempDir, '7', 'notes.md');
      expect(content).toBe('# Notes\nSome notes here');
    });

    it('should return null for nonexistent spec', () => {
      const content = planner.readSpec(tempDir, '999', 'nope.md');
      expect(content).toBeNull();
    });
  });

  describe('savePlanSpec', () => {
    it('should save a plan.md with task title and planning output', () => {
      const now = new Date().toISOString();
      const item: TaskItem = {
        id: '5',
        title: 'Implement auth',
        description: 'OAuth2 with Google',
        status: 'planning',
        source: 'user',
        createdAt: now,
        updatedAt: now,
      };

      const planOutput = '## Acceptance Criteria\n- [ ] Users can login\n\n## Questions\n- None';
      const filePath = planner.savePlanSpec(tempDir, item, planOutput);

      expect(filePath).toBe(path.join(tempDir, '.specs', '5', 'plan.md'));
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('Task #5: Implement auth');
      expect(content).toContain('OAuth2 with Google');
      expect(content).toContain('## Acceptance Criteria');
    });
  });

  describe('saveImplementationSpec', () => {
    it('should save an implementation.md with output', () => {
      const now = new Date().toISOString();
      const item: TaskItem = {
        id: '8',
        title: 'Add caching',
        status: 'in_progress',
        source: 'user',
        createdAt: now,
        updatedAt: now,
      };

      const implOutput = 'Added Redis caching with 5-minute TTL.';
      const filePath = planner.saveImplementationSpec(tempDir, item, implOutput);

      expect(filePath).toBe(path.join(tempDir, '.specs', '8', 'implementation.md'));
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('Implementation: Task #8');
      expect(content).toContain('Add caching');
      expect(content).toContain('Redis caching');
    });
  });

  // --- generateImplementationPrompt ---

  describe('generateImplementationPrompt', () => {
    it('should include task title and description', () => {
      const now = new Date().toISOString();
      const item: TaskItem = {
        id: '3',
        title: 'Build user profile page',
        description: 'Show name, email, and avatar',
        status: 'in_progress',
        source: 'user',
        createdAt: now,
        updatedAt: now,
      };

      const prompt = planner.generateImplementationPrompt(item, tempDir);

      expect(prompt).toContain('#3');
      expect(prompt).toContain('Build user profile page');
      expect(prompt).toContain('Show name, email, and avatar');
    });

    it('should include acceptance criteria when present', () => {
      const now = new Date().toISOString();
      const item: TaskItem = {
        id: '4',
        title: 'Task with AC',
        acceptanceCriteria: ['Users can log in', 'Session persists'],
        status: 'in_progress',
        source: 'user',
        createdAt: now,
        updatedAt: now,
      };

      const prompt = planner.generateImplementationPrompt(item, tempDir);

      expect(prompt).toContain('Users can log in');
      expect(prompt).toContain('Session persists');
    });

    it('should include spec context from plan.md if it exists', () => {
      const now = new Date().toISOString();
      const item: TaskItem = {
        id: '6',
        title: 'Task with existing plan',
        status: 'in_progress',
        source: 'user',
        createdAt: now,
        updatedAt: now,
      };

      // Write a plan spec first
      planner.writeSpec(tempDir, '6', 'plan.md', '# Detailed plan\nStep 1: Do something\nStep 2: Do more');

      const prompt = planner.generateImplementationPrompt(item, tempDir);

      expect(prompt).toContain('Detailed plan');
      expect(prompt).toContain('Step 1: Do something');
    });

    it('should work without existing plan spec', () => {
      const now = new Date().toISOString();
      const item: TaskItem = {
        id: '99',
        title: 'No plan task',
        status: 'in_progress',
        source: 'user',
        createdAt: now,
        updatedAt: now,
      };

      const prompt = planner.generateImplementationPrompt(item, tempDir);

      expect(prompt).toContain('#99');
      expect(prompt).toContain('No plan task');
      expect(prompt).not.toContain('Planning Spec');
    });
  });

  // --- generatePlanningPrompt with projectPath ---

  describe('generatePlanningPrompt with projectPath', () => {
    it('should include spec save path note', () => {
      const now = new Date().toISOString();
      const item: TaskItem = {
        id: '11',
        title: 'Plan with path',
        status: 'planning',
        source: 'user',
        createdAt: now,
        updatedAt: now,
      };

      const prompt = planner.generatePlanningPrompt(item, tempDir);

      expect(prompt).toContain('.specs/11/plan.md');
    });

    it('should include existing spec context if plan.md already exists', () => {
      const now = new Date().toISOString();
      const item: TaskItem = {
        id: '12',
        title: 'Re-plan task',
        status: 'planning',
        source: 'user',
        createdAt: now,
        updatedAt: now,
      };

      // Write an existing plan
      planner.writeSpec(tempDir, '12', 'plan.md', '# Previous plan\nOld acceptance criteria here');

      const prompt = planner.generatePlanningPrompt(item, tempDir);

      expect(prompt).toContain('Existing spec context');
      expect(prompt).toContain('Previous plan');
    });
  });
});
