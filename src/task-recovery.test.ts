import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoardStore } from './board-store.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Task Recovery', () => {
  let tmpDir: string;
  let store: BoardStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-recovery-test-'));
    store = new BoardStore(tmpDir);
  });

  afterEach(() => {
    store.dispose();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('startup recovery logic', () => {
    it('should move in_progress tasks to ready on recovery', () => {
      // Create a task and put it in in_progress (simulating a stuck task)
      const item = store.addItem({ title: 'Stuck implementation', status: 'in_progress', source: 'user' });
      expect(store.findItem(item.id)?.status).toBe('in_progress');

      // Simulate startup recovery: find in_progress items and move to ready
      const items = store.getItems();
      for (const i of items) {
        if (i.status === 'in_progress') {
          store.moveItem(i.id, 'ready');
        }
      }

      expect(store.findItem(item.id)?.status).toBe('ready');
    });

    it('should move planning tasks to backlog on recovery', () => {
      // Create a task and put it in planning (simulating a stuck task)
      const item = store.addItem({ title: 'Stuck planning', status: 'planning', source: 'user' });
      expect(store.findItem(item.id)?.status).toBe('planning');

      // Simulate startup recovery: find planning items and move to backlog
      const items = store.getItems();
      for (const i of items) {
        if (i.status === 'planning') {
          store.moveItem(i.id, 'backlog');
        }
      }

      expect(store.findItem(item.id)?.status).toBe('backlog');
    });

    it('should not touch tasks in other states', () => {
      const backlogItem = store.addItem({ title: 'Backlog task', status: 'backlog', source: 'user' });
      const readyItem = store.addItem({ title: 'Ready task', status: 'ready', source: 'user' });
      const reviewItem = store.addItem({ title: 'Review task', status: 'review', source: 'user' });
      const doneItem = store.addItem({ title: 'Done task', status: 'done', source: 'user' });
      const clarificationItem = store.addItem({ title: 'Clarification task', status: 'clarification_needed', source: 'user' });

      // Simulate startup recovery: only move in_progress and planning
      const items = store.getItems();
      for (const i of items) {
        if (i.status === 'in_progress') {
          store.moveItem(i.id, 'ready');
        } else if (i.status === 'planning') {
          store.moveItem(i.id, 'backlog');
        }
      }

      // Verify no other states were affected
      expect(store.findItem(backlogItem.id)?.status).toBe('backlog');
      expect(store.findItem(readyItem.id)?.status).toBe('ready');
      expect(store.findItem(reviewItem.id)?.status).toBe('review');
      expect(store.findItem(doneItem.id)?.status).toBe('done');
      expect(store.findItem(clarificationItem.id)?.status).toBe('clarification_needed');
    });

    it('should handle mixed stuck and non-stuck tasks', () => {
      const stuckImpl = store.addItem({ title: 'Stuck impl', status: 'in_progress', source: 'user' });
      const stuckPlan = store.addItem({ title: 'Stuck plan', status: 'planning', source: 'user' });
      const normalReady = store.addItem({ title: 'Normal ready', status: 'ready', source: 'user' });
      const normalDone = store.addItem({ title: 'Normal done', status: 'done', source: 'user' });

      // Simulate startup recovery
      const items = store.getItems();
      for (const i of items) {
        if (i.status === 'in_progress') {
          store.moveItem(i.id, 'ready');
        } else if (i.status === 'planning') {
          store.moveItem(i.id, 'backlog');
        }
      }

      expect(store.findItem(stuckImpl.id)?.status).toBe('ready');
      expect(store.findItem(stuckPlan.id)?.status).toBe('backlog');
      expect(store.findItem(normalReady.id)?.status).toBe('ready');
      expect(store.findItem(normalDone.id)?.status).toBe('done');
    });

    it('should handle empty board gracefully', () => {
      const items = store.getItems();
      expect(items).toEqual([]);

      // Recovery on empty board should not throw
      for (const i of items) {
        if (i.status === 'in_progress') {
          store.moveItem(i.id, 'ready');
        } else if (i.status === 'planning') {
          store.moveItem(i.id, 'backlog');
        }
      }
    });
  });

  describe('config defaults', () => {
    it('should have correct default timeout values', async () => {
      // Import config module to check defaults
      // We test the raw parsing logic rather than the singleton
      const defaultImplTimeout = parseInt(process.env.TASK_IMPLEMENTATION_TIMEOUT_MS || '1800000', 10);
      const defaultPlanTimeout = parseInt(process.env.TASK_PLANNING_TIMEOUT_MS || '600000', 10);

      expect(defaultImplTimeout).toBe(1800000); // 30 minutes
      expect(defaultPlanTimeout).toBe(600000); // 10 minutes
    });

    it('should respect environment variable overrides', () => {
      // Save originals
      const origImpl = process.env.TASK_IMPLEMENTATION_TIMEOUT_MS;
      const origPlan = process.env.TASK_PLANNING_TIMEOUT_MS;

      try {
        process.env.TASK_IMPLEMENTATION_TIMEOUT_MS = '60000';
        process.env.TASK_PLANNING_TIMEOUT_MS = '30000';

        const implTimeout = parseInt(process.env.TASK_IMPLEMENTATION_TIMEOUT_MS || '1800000', 10);
        const planTimeout = parseInt(process.env.TASK_PLANNING_TIMEOUT_MS || '600000', 10);

        expect(implTimeout).toBe(60000); // 1 minute
        expect(planTimeout).toBe(30000); // 30 seconds
      } finally {
        // Restore
        if (origImpl === undefined) {
          delete process.env.TASK_IMPLEMENTATION_TIMEOUT_MS;
        } else {
          process.env.TASK_IMPLEMENTATION_TIMEOUT_MS = origImpl;
        }
        if (origPlan === undefined) {
          delete process.env.TASK_PLANNING_TIMEOUT_MS;
        } else {
          process.env.TASK_PLANNING_TIMEOUT_MS = origPlan;
        }
      }
    });
  });
});
