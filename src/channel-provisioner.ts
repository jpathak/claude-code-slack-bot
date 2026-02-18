import * as fs from 'fs';
import * as path from 'path';
import bolt from '@slack/bolt';
const { App } = bolt;
type AppType = InstanceType<typeof App>;
import { Logger } from './logger.js';
import { config } from './config.js';
import { ProjectConfig } from './project-config.js';
import { WorkingDirectoryManager } from './working-directory-manager.js';
import { KanbanManager } from './kanban-manager.js';
import { ProjectMapping } from './types.js';

interface ProjectInfo {
  name: string;
  path: string;
}

export interface SyncResult {
  scanned: number;
  created: number;
  adopted: number;
  skipped: number;
  errors: string[];
}

const RATE_LIMIT_DELAY_MS = 200;
const HIDDEN_DIR_PREFIXES = ['.', '_'];

export class ChannelProvisioner {
  private app: AppType;
  private projectConfig: ProjectConfig;
  private workingDirManager: WorkingDirectoryManager;
  private kanbanManager: KanbanManager;
  private logger = new Logger('ChannelProvisioner');

  constructor(
    app: AppType,
    projectConfig: ProjectConfig,
    workingDirManager: WorkingDirectoryManager,
    kanbanManager: KanbanManager,
  ) {
    this.app = app;
    this.projectConfig = projectConfig;
    this.workingDirManager = workingDirManager;
    this.kanbanManager = kanbanManager;
  }

  /**
   * Main entry point: scan projects and provision channels.
   */
  async syncAll(): Promise<SyncResult> {
    const result: SyncResult = { scanned: 0, created: 0, adopted: 0, skipped: 0, errors: [] };

    if (!config.baseDirectory) {
      this.logger.warn('No BASE_DIRECTORY configured, skipping channel sync');
      return result;
    }

    if (!config.kanban.autoProvision) {
      this.logger.info('Auto-provision disabled, skipping channel sync');
      return result;
    }

    this.logger.info('Starting project sync', { baseDirectory: config.baseDirectory });

    try {
      const projects = this.scanProjects();
      result.scanned = projects.length;

      const existingChannels = await this.getExistingChannels();

      for (const project of projects) {
        try {
          const provisionResult = await this.provisionChannel(project, existingChannels);
          switch (provisionResult) {
            case 'created':
              result.created++;
              break;
            case 'adopted':
              result.adopted++;
              break;
            case 'skipped':
              result.skipped++;
              break;
          }
          // Rate-limit delay between channel operations
          await this.delay(RATE_LIMIT_DELAY_MS);
        } catch (error) {
          const msg = `Failed to provision ${project.name}: ${(error as Error).message}`;
          result.errors.push(msg);
          this.logger.error(msg, error);
        }
      }

      this.logger.info('Project sync completed', result);
    } catch (error) {
      this.logger.error('Project sync failed', error);
      result.errors.push((error as Error).message);
    }

    return result;
  }

  /**
   * Scan the base directory for project folders.
   */
  scanProjects(): ProjectInfo[] {
    const baseDir = config.baseDirectory;
    if (!baseDir || !fs.existsSync(baseDir)) {
      return [];
    }

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const projects: ProjectInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip hidden directories
      if (HIDDEN_DIR_PREFIXES.some(prefix => entry.name.startsWith(prefix))) continue;

      projects.push({
        name: entry.name,
        path: path.join(baseDir, entry.name),
      });
    }

    this.logger.info('Scanned projects', { count: projects.length });
    return projects;
  }

  /**
   * Get all existing channels with pagination.
   * Returns a Map of channel name -> channel ID.
   */
  async getExistingChannels(): Promise<Map<string, string>> {
    const channels = new Map<string, string>();
    let cursor: string | undefined;

    do {
      const response = await this.app.client.conversations.list({
        types: 'public_channel',
        limit: 200,
        cursor,
        exclude_archived: true,
      });

      if (response.channels) {
        for (const channel of response.channels) {
          if (channel.name && channel.id) {
            channels.set(channel.name, channel.id);
          }
        }
      }

      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    this.logger.debug('Fetched existing channels', { count: channels.size });
    return channels;
  }

  /**
   * Provision a channel for a project: create or adopt existing.
   */
  private async provisionChannel(
    project: ProjectInfo,
    existingChannels: Map<string, string>,
  ): Promise<'created' | 'adopted' | 'skipped'> {
    const channelName = this.normalizeChannelName(project.name);

    // Already in our config?
    if (this.projectConfig.hasProject(project.name)) {
      this.logger.debug('Project already provisioned, skipping', { project: project.name });
      return 'skipped';
    }

    // Check if a channel with this name already exists in Slack
    const existingChannelId = existingChannels.get(channelName);
    if (existingChannelId) {
      return this.adoptChannel(existingChannelId, channelName, project);
    }

    // Create a new channel
    return this.createChannel(channelName, project);
  }

  /**
   * Adopt an existing channel: set working directory and save mapping.
   */
  private async adoptChannel(
    channelId: string,
    channelName: string,
    project: ProjectInfo,
  ): Promise<'adopted'> {
    this.logger.info('Adopting existing channel', { channelName, channelId, project: project.name });

    // Set the working directory for this channel
    this.workingDirManager.setWorkingDirectory(channelId, project.path);

    // Try to create a kanban list
    let listId: string | null = null;
    try {
      listId = await this.kanbanManager.ensureList(channelId, project.name);
    } catch (error) {
      this.logger.warn('Failed to create kanban list for adopted channel', { channelName, error });
    }

    // Save mapping
    const mapping: ProjectMapping = {
      channelId,
      channelName,
      projectPath: project.path,
      projectName: project.name,
      listId,
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    };
    this.projectConfig.upsert(mapping);

    return 'adopted';
  }

  /**
   * Create a new channel, set topic + cwd, and save mapping.
   */
  private async createChannel(
    channelName: string,
    project: ProjectInfo,
  ): Promise<'created'> {
    this.logger.info('Creating channel', { channelName, project: project.name });

    const createResult = await this.app.client.conversations.create({
      name: channelName,
      is_private: false,
    });

    const channelId = createResult.channel?.id;
    if (!channelId) {
      throw new Error(`Failed to create channel ${channelName}: no channel ID returned`);
    }

    // Set channel topic
    try {
      await this.app.client.conversations.setTopic({
        channel: channelId,
        topic: `Project: ${project.name} | Path: ${project.path}`,
      });
    } catch (error) {
      this.logger.warn('Failed to set channel topic', { channelName, error });
    }

    // Set working directory
    this.workingDirManager.setWorkingDirectory(channelId, project.path);

    // Try to create a kanban list
    let listId: string | null = null;
    try {
      listId = await this.kanbanManager.ensureList(channelId, project.name);
    } catch (error) {
      this.logger.warn('Failed to create kanban list for new channel', { channelName, error });
    }

    // Save mapping
    const mapping: ProjectMapping = {
      channelId,
      channelName,
      projectPath: project.path,
      projectName: project.name,
      listId,
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    };
    this.projectConfig.upsert(mapping);

    // Post welcome message
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `Welcome to *#${channelName}*! This channel is auto-mapped to \`${project.path}\`.\n\nWorking directory is already set. Just start chatting!\n\nCommands: \`board\` (kanban), \`add task <desc>\`, \`done <ref>\`, \`sync\``,
      });
    } catch (error) {
      this.logger.warn('Failed to post welcome message', { channelName, error });
    }

    return 'created';
  }

  /**
   * Normalize a directory name into a valid Slack channel name.
   * Rules: lowercase, replace non-alphanumeric with '-', collapse '--', strip leading/trailing '-',
   * prefix with configured prefix, truncate to 80 chars.
   */
  normalizeChannelName(dirName: string): string {
    const prefix = config.kanban.channelPrefix;
    let normalized = dirName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');

    const maxLen = 80 - prefix.length;
    if (normalized.length > maxLen) {
      normalized = normalized.substring(0, maxLen).replace(/-+$/, '');
    }

    return `${prefix}${normalized}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
