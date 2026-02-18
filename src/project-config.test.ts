import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectConfig } from './project-config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('ProjectConfig', () => {
  let configPath: string;
  let config: ProjectConfig;

  beforeEach(() => {
    configPath = path.join(os.tmpdir(), `project-config-test-${Date.now()}.json`);
    config = new ProjectConfig(configPath);
  });

  afterEach(() => {
    try {
      if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
      }
    } catch {
      // ignore
    }
  });

  describe('constructor', () => {
    it('should start with empty mappings when no file exists', () => {
      expect(config.getAll()).toEqual([]);
    });

    it('should load existing config from file', () => {
      // Write initial config
      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        projects: [
          {
            channelId: 'C123',
            channelName: 'proj-test',
            projectPath: '/home/user/workspace/test',
            projectName: 'test',
            listId: null,
            createdAt: new Date().toISOString(),
            lastSyncedAt: new Date().toISOString(),
          },
        ],
      };
      fs.writeFileSync(configPath, JSON.stringify(data), 'utf-8');

      const loaded = new ProjectConfig(configPath);
      expect(loaded.getAll()).toHaveLength(1);
      expect(loaded.getByChannelId('C123')?.projectName).toBe('test');
    });
  });

  describe('upsert', () => {
    it('should add a new mapping and persist', () => {
      config.upsert({
        channelId: 'C123',
        channelName: 'proj-test',
        projectPath: '/home/user/workspace/test',
        projectName: 'test',
        listId: null,
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });

      expect(config.getAll()).toHaveLength(1);
      expect(fs.existsSync(configPath)).toBe(true);
    });

    it('should update existing mapping', () => {
      config.upsert({
        channelId: 'C123',
        channelName: 'proj-test',
        projectPath: '/home/user/workspace/test',
        projectName: 'test',
        listId: null,
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });

      config.upsert({
        channelId: 'C123',
        channelName: 'proj-test',
        projectPath: '/home/user/workspace/test-v2',
        projectName: 'test',
        listId: 'L456',
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });

      expect(config.getAll()).toHaveLength(1);
      expect(config.getByChannelId('C123')?.projectPath).toBe('/home/user/workspace/test-v2');
    });
  });

  describe('lookups', () => {
    beforeEach(() => {
      config.upsert({
        channelId: 'C123',
        channelName: 'proj-alpha',
        projectPath: '/home/user/workspace/alpha',
        projectName: 'alpha',
        listId: 'L999',
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });
      config.upsert({
        channelId: 'C456',
        channelName: 'proj-beta',
        projectPath: '/home/user/workspace/beta',
        projectName: 'beta',
        listId: null,
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });
    });

    it('should get by channel ID', () => {
      expect(config.getByChannelId('C123')?.projectName).toBe('alpha');
      expect(config.getByChannelId('CXXX')).toBeUndefined();
    });

    it('should get by project path', () => {
      expect(config.getByProjectPath('/home/user/workspace/alpha')?.channelId).toBe('C123');
      expect(config.getByProjectPath('/nonexistent')).toBeUndefined();
    });

    it('should get by project name', () => {
      expect(config.getByProjectName('beta')?.channelId).toBe('C456');
      expect(config.getByProjectName('gamma')).toBeUndefined();
    });

    it('should get list ID for channel', () => {
      expect(config.getListIdForChannel('C123')).toBe('L999');
      expect(config.getListIdForChannel('C456')).toBeNull();
      expect(config.getListIdForChannel('CXXX')).toBeNull();
    });

    it('should get channel ID for project path', () => {
      expect(config.getChannelIdForProject('/home/user/workspace/alpha')).toBe('C123');
      expect(config.getChannelIdForProject('/nonexistent')).toBeUndefined();
    });

    it('should check hasProject', () => {
      expect(config.hasProject('alpha')).toBe(true);
      expect(config.hasProject('gamma')).toBe(false);
    });
  });

  describe('updateListId', () => {
    it('should update the list ID for a channel', () => {
      config.upsert({
        channelId: 'C123',
        channelName: 'proj-test',
        projectPath: '/home/user/workspace/test',
        projectName: 'test',
        listId: null,
        createdAt: new Date().toISOString(),
        lastSyncedAt: new Date().toISOString(),
      });

      config.updateListId('C123', 'L-NEW');
      expect(config.getListIdForChannel('C123')).toBe('L-NEW');
    });

    it('should do nothing for unknown channel', () => {
      config.updateListId('CXXX', 'L-NEW');
      expect(config.getListIdForChannel('CXXX')).toBeNull();
    });
  });

  describe('persistence', () => {
    it('should persist and reload', () => {
      config.upsert({
        channelId: 'C123',
        channelName: 'proj-test',
        projectPath: '/home/user/workspace/test',
        projectName: 'test',
        listId: 'L999',
        createdAt: '2024-01-01T00:00:00Z',
        lastSyncedAt: '2024-01-01T00:00:00Z',
      });

      // Create a new config instance that reads from the same file
      const reloaded = new ProjectConfig(configPath);
      expect(reloaded.getAll()).toHaveLength(1);
      expect(reloaded.getByChannelId('C123')?.listId).toBe('L999');
    });
  });
});
