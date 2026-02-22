import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ChannelProvisioner } from './channel-provisioner.js';
import { ProjectConfig } from './project-config.js';
import { WorkingDirectoryManager } from './working-directory-manager.js';
import { TaskManager } from './task-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock config module
vi.mock('./config.js', () => ({
  config: {
    baseDirectory: '',
    tasks: {
      enabled: true,
      autoProvision: true,
      channelPrefix: 'proj-',
    },
  },
}));

import { config } from './config.js';

function createMockApp() {
  return {
    client: {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [], response_metadata: {} }),
        create: vi.fn().mockResolvedValue({ channel: { id: 'C-NEW' } }),
        setTopic: vi.fn().mockResolvedValue({ ok: true }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
      apiCall: vi.fn().mockRejectedValue(new Error('not_allowed')),
    },
  } as any;
}

describe('ChannelProvisioner', () => {
  let app: any;
  let projectConfig: ProjectConfig;
  let workingDirManager: WorkingDirectoryManager;
  let taskManager: TaskManager;
  let provisioner: ChannelProvisioner;
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    app = createMockApp();
    configPath = path.join(os.tmpdir(), `project-config-prov-test-${Date.now()}.json`);
    projectConfig = new ProjectConfig(configPath);
    workingDirManager = new WorkingDirectoryManager();
    taskManager = new TaskManager(app, projectConfig);
    provisioner = new ChannelProvisioner(app, projectConfig, workingDirManager, taskManager);

    // Create a temp workspace directory
    tmpDir = path.join(os.tmpdir(), `workspace-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    } catch {
      // ignore
    }
  });

  describe('normalizeChannelName', () => {
    it('should lowercase and prefix', () => {
      expect(provisioner.normalizeChannelName('MyProject')).toBe('proj-myproject');
    });

    it('should replace non-alphanumeric with dashes', () => {
      expect(provisioner.normalizeChannelName('My Cool Project!')).toBe('proj-my-cool-project');
    });

    it('should collapse multiple dashes', () => {
      expect(provisioner.normalizeChannelName('my--project')).toBe('proj-my-project');
    });

    it('should strip leading and trailing dashes', () => {
      expect(provisioner.normalizeChannelName('-project-')).toBe('proj-project');
    });

    it('should handle underscores', () => {
      expect(provisioner.normalizeChannelName('my_project_v2')).toBe('proj-my-project-v2');
    });

    it('should truncate long names', () => {
      const longName = 'a'.repeat(100);
      const result = provisioner.normalizeChannelName(longName);
      expect(result.length).toBeLessThanOrEqual(80);
      expect(result.startsWith('proj-')).toBe(true);
    });
  });

  describe('scanProjects', () => {
    it('should return empty when base directory not set', () => {
      (config as any).baseDirectory = '';
      expect(provisioner.scanProjects()).toEqual([]);
    });

    it('should scan directories in base directory', () => {
      (config as any).baseDirectory = tmpDir;

      // Create test project dirs
      fs.mkdirSync(path.join(tmpDir, 'project-a'));
      fs.mkdirSync(path.join(tmpDir, 'project-b'));
      // Create a file (should be skipped)
      fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hello');
      // Create hidden dirs (should be skipped)
      fs.mkdirSync(path.join(tmpDir, '.git'));
      fs.mkdirSync(path.join(tmpDir, '_cache'));

      const projects = provisioner.scanProjects();
      expect(projects).toHaveLength(2);
      expect(projects.map(p => p.name).sort()).toEqual(['project-a', 'project-b']);
    });
  });

  describe('syncAll', () => {
    it('should skip when no base directory', async () => {
      (config as any).baseDirectory = '';
      const result = await provisioner.syncAll();
      expect(result.scanned).toBe(0);
    });

    it('should skip when auto-provision disabled', async () => {
      (config as any).baseDirectory = tmpDir;
      (config as any).tasks.autoProvision = false;
      const result = await provisioner.syncAll();
      expect(result.scanned).toBe(0);
      // Reset
      (config as any).tasks.autoProvision = true;
    });

    it('should create channels for new projects', async () => {
      (config as any).baseDirectory = tmpDir;
      fs.mkdirSync(path.join(tmpDir, 'my-app'));

      app.client.conversations.list.mockResolvedValue({
        channels: [],
        response_metadata: {},
      });

      const result = await provisioner.syncAll();
      expect(result.scanned).toBe(1);
      expect(result.created).toBe(1);
      expect(app.client.conversations.create).toHaveBeenCalledWith({
        name: 'proj-my-app',
        is_private: false,
      });
    });

    it('should adopt existing channels', async () => {
      (config as any).baseDirectory = tmpDir;
      fs.mkdirSync(path.join(tmpDir, 'existing-project'));

      app.client.conversations.list.mockResolvedValue({
        channels: [{ name: 'proj-existing-project', id: 'C-EXIST' }],
        response_metadata: {},
      });

      const result = await provisioner.syncAll();
      expect(result.scanned).toBe(1);
      expect(result.adopted).toBe(1);
      expect(app.client.conversations.create).not.toHaveBeenCalled();
    });

    it('should skip already-provisioned projects', async () => {
      (config as any).baseDirectory = tmpDir;
      fs.mkdirSync(path.join(tmpDir, 'done-project'));

      // Pre-populate config
      projectConfig.upsert({
        channelId: 'C-DONE',
        channelName: 'proj-done-project',
        projectPath: path.join(tmpDir, 'done-project'),
        projectName: 'done-project',
        listId: null,
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });

      const result = await provisioner.syncAll();
      expect(result.scanned).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.created).toBe(0);
    });
  });
});
