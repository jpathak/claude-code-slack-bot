import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger.js';
import { ProjectMapping } from './types.js';

export class ProjectConfig {
  private logger = new Logger('ProjectConfig');
  private configPath: string;
  private mappings: Map<string, ProjectMapping> = new Map();

  constructor(configPath: string = './project-config.json') {
    this.configPath = path.resolve(configPath);
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.logger.info('No project config file found, starting fresh', { path: this.configPath });
        return;
      }

      const content = fs.readFileSync(this.configPath, 'utf-8');
      const data = JSON.parse(content);

      if (Array.isArray(data.projects)) {
        for (const project of data.projects) {
          this.mappings.set(project.channelId, project);
        }
        this.logger.info('Loaded project config', {
          path: this.configPath,
          count: this.mappings.size,
        });
      }
    } catch (error) {
      this.logger.error('Failed to load project config', error);
    }
  }

  save(): void {
    try {
      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        projects: Array.from(this.mappings.values()),
      };
      fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf-8');
      this.logger.debug('Saved project config', { count: this.mappings.size });
    } catch (error) {
      this.logger.error('Failed to save project config', error);
    }
  }

  getByChannelId(channelId: string): ProjectMapping | undefined {
    return this.mappings.get(channelId);
  }

  getByProjectPath(projectPath: string): ProjectMapping | undefined {
    for (const mapping of this.mappings.values()) {
      if (mapping.projectPath === projectPath) {
        return mapping;
      }
    }
    return undefined;
  }

  getByProjectName(projectName: string): ProjectMapping | undefined {
    for (const mapping of this.mappings.values()) {
      if (mapping.projectName === projectName) {
        return mapping;
      }
    }
    return undefined;
  }

  upsert(mapping: ProjectMapping): void {
    this.mappings.set(mapping.channelId, mapping);
    this.save();
    this.logger.info('Upserted project mapping', {
      channelId: mapping.channelId,
      channelName: mapping.channelName,
      projectName: mapping.projectName,
    });
  }

  getAll(): ProjectMapping[] {
    return Array.from(this.mappings.values());
  }

  getListIdForChannel(channelId: string): string | null {
    return this.mappings.get(channelId)?.listId ?? null;
  }

  getChannelIdForProject(projectPath: string): string | undefined {
    return this.getByProjectPath(projectPath)?.channelId;
  }

  hasProject(projectName: string): boolean {
    return !!this.getByProjectName(projectName);
  }

  updateListId(channelId: string, listId: string): void {
    const mapping = this.mappings.get(channelId);
    if (mapping) {
      mapping.listId = listId;
      mapping.lastSyncedAt = new Date().toISOString();
      this.save();
    }
  }
}
