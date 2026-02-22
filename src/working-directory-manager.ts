import { WorkingDirectoryConfig } from './types.js';
import { Logger } from './logger.js';
import { config } from './config.js';
import * as path from 'path';
import * as fs from 'fs';

export class WorkingDirectoryManager {
  private configs: Map<string, WorkingDirectoryConfig> = new Map();
  private logger = new Logger('WorkingDirectoryManager');

  getConfigKey(channelId: string, threadTs?: string, userId?: string): string {
    if (threadTs) {
      return `${channelId}-${threadTs}`;
    }
    if (userId && channelId.startsWith('D')) { // Direct message
      return `${channelId}-${userId}`;
    }
    return channelId;
  }

  setWorkingDirectory(channelId: string, directory: string, threadTs?: string, userId?: string): { success: boolean; resolvedPath?: string; error?: string } {
    try {
      const resolvedPath = this.resolveDirectory(directory);
      
      if (!resolvedPath) {
        return { 
          success: false, 
          error: `Directory not found: "${directory}"${config.baseDirectory ? ` (checked in base directory: ${config.baseDirectory})` : ''}` 
        };
      }

      const stats = fs.statSync(resolvedPath);
      
      if (!stats.isDirectory()) {
        this.logger.warn('Path is not a directory', { directory: resolvedPath });
        return { success: false, error: 'Path is not a directory' };
      }

      const key = this.getConfigKey(channelId, threadTs, userId);
      const workingDirConfig: WorkingDirectoryConfig = {
        channelId,
        threadTs,
        userId,
        directory: resolvedPath,
        setAt: new Date(),
      };

      this.configs.set(key, workingDirConfig);
      this.logger.info('Working directory set', {
        key,
        directory: resolvedPath,
        originalInput: directory,
        isThread: !!threadTs,
        isDM: channelId.startsWith('D'),
      });

      return { success: true, resolvedPath };
    } catch (error) {
      this.logger.error('Failed to set working directory', error);
      return { success: false, error: 'Directory does not exist or is not accessible' };
    }
  }

  private resolveDirectory(directory: string): string | null {
    // If it's an absolute path, use it directly
    if (path.isAbsolute(directory)) {
      const resolved = path.resolve(directory);
      // Security: Ensure the path doesn't contain path traversal sequences
      if (this.containsPathTraversal(directory)) {
        this.logger.warn('Path traversal detected in absolute path', { directory });
        return null;
      }
      if (fs.existsSync(resolved)) {
        return resolved;
      }
      return null;
    }

    // Security: Check for path traversal in relative paths
    if (this.containsPathTraversal(directory)) {
      this.logger.warn('Path traversal detected in relative path', { directory });
      return null;
    }

    // If we have a base directory configured, try relative to base directory first
    if (config.baseDirectory) {
      const baseRelativePath = path.join(config.baseDirectory, directory);
      const resolved = path.resolve(baseRelativePath);

      // Security: Ensure resolved path is still within the base directory
      if (!resolved.startsWith(path.resolve(config.baseDirectory))) {
        this.logger.warn('Path escapes base directory', {
          directory,
          resolved,
          baseDirectory: config.baseDirectory
        });
        return null;
      }

      if (fs.existsSync(resolved)) {
        this.logger.debug('Found directory relative to base', {
          input: directory,
          baseDirectory: config.baseDirectory,
          resolved
        });
        return resolved;
      }
    }

    // Try relative to current working directory
    const cwdRelativePath = path.resolve(directory);
    if (fs.existsSync(cwdRelativePath)) {
      this.logger.debug('Found directory relative to cwd', {
        input: directory,
        resolved: cwdRelativePath
      });
      return cwdRelativePath;
    }

    return null;
  }

  /**
   * Check if a path contains path traversal sequences.
   * This is a security measure to prevent directory escape attacks.
   */
  private containsPathTraversal(inputPath: string): boolean {
    // Normalize the path to detect hidden traversal
    const normalized = path.normalize(inputPath);

    // Check for obvious traversal patterns
    if (inputPath.includes('..')) {
      return true;
    }

    // Check if normalization changed a path in a way that suggests traversal
    // (e.g., "foo/../bar" becomes "bar")
    if (normalized !== inputPath && inputPath.includes('/')) {
      const inputParts = inputPath.split(path.sep).filter(p => p !== '');
      const normalizedParts = normalized.split(path.sep).filter(p => p !== '');
      if (normalizedParts.length < inputParts.length) {
        return true;
      }
    }

    return false;
  }

  getWorkingDirectory(channelId: string, threadTs?: string, userId?: string): string | undefined {
    // Priority: Thread > Channel/DM > Base Directory (if set)
    if (threadTs) {
      const threadKey = this.getConfigKey(channelId, threadTs);
      const threadConfig = this.configs.get(threadKey);
      if (threadConfig) {
        this.logger.debug('Using thread-specific working directory', {
          directory: threadConfig.directory,
          threadTs,
        });
        return threadConfig.directory;
      }
    }

    // Fall back to channel or DM config
    const channelKey = this.getConfigKey(channelId, undefined, userId);
    const channelConfig = this.configs.get(channelKey);
    if (channelConfig) {
      this.logger.debug('Using channel/DM working directory', {
        directory: channelConfig.directory,
        channelId,
      });
      return channelConfig.directory;
    }

    // Fall back to base directory if configured
    if (config.baseDirectory && fs.existsSync(config.baseDirectory)) {
      this.logger.debug('Using base directory as fallback', {
        directory: config.baseDirectory,
        channelId,
      });
      return config.baseDirectory;
    }

    this.logger.debug('No working directory configured', { channelId, threadTs });
    return undefined;
  }

  /**
   * Get working directory only if explicitly set (no base directory fallback)
   * Use this for session commands where we need the exact project directory
   */
  getExplicitWorkingDirectory(channelId: string, threadTs?: string, userId?: string): string | undefined {
    // Priority: Thread > Channel/DM (NO base directory fallback)
    if (threadTs) {
      const threadKey = this.getConfigKey(channelId, threadTs);
      const threadConfig = this.configs.get(threadKey);
      if (threadConfig) {
        this.logger.debug('Using thread-specific working directory (explicit)', {
          directory: threadConfig.directory,
          threadTs,
        });
        return threadConfig.directory;
      }
    }

    // Fall back to channel or DM config only
    const channelKey = this.getConfigKey(channelId, undefined, userId);
    const channelConfig = this.configs.get(channelKey);
    if (channelConfig) {
      this.logger.debug('Using channel/DM working directory (explicit)', {
        directory: channelConfig.directory,
        channelId,
      });
      return channelConfig.directory;
    }

    this.logger.debug('No explicit working directory configured', { channelId, threadTs });
    return undefined;
  }

  removeWorkingDirectory(channelId: string, threadTs?: string, userId?: string): boolean {
    const key = this.getConfigKey(channelId, threadTs, userId);
    const result = this.configs.delete(key);
    if (result) {
      this.logger.info('Working directory removed', { key });
    }
    return result;
  }

  listConfigurations(): WorkingDirectoryConfig[] {
    return Array.from(this.configs.values());
  }

  parseSetCommand(text: string): string | null {
    const cwdMatch = text.match(/^cwd\s+(.+)$/i);
    if (cwdMatch) {
      return cwdMatch[1].trim();
    }

    const setMatch = text.match(/^set\s+(?:cwd|dir|directory|working[- ]?directory)\s+(.+)$/i);
    if (setMatch) {
      return setMatch[1].trim();
    }

    return null;
  }

  isGetCommand(text: string): boolean {
    return /^(get\s+)?(cwd|dir|directory|working[- ]?directory)(\?)?$/i.test(text.trim());
  }

  formatDirectoryMessage(directory: string | undefined, context: string): string {
    if (directory) {
      let message = `Current working directory for ${context}: \`${directory}\``;
      if (config.baseDirectory) {
        message += `\n\nBase directory: \`${config.baseDirectory}\``;
        message += `\nYou can use relative paths like \`cwd project-name\` or absolute paths.`;
      }
      return message;
    }
    
    let message = `No working directory set for ${context}. Please set one using:`;
    if (config.baseDirectory) {
      message += `\n\`cwd project-name\` (relative to base directory)`;
      message += `\n\`cwd /absolute/path/to/directory\` (absolute path)`;
      message += `\n\nBase directory: \`${config.baseDirectory}\``;
    } else {
      message += `\n\`cwd /path/to/directory\` or \`set directory /path/to/directory\``;
    }
    return message;
  }

  getChannelWorkingDirectory(channelId: string): string | undefined {
    const key = this.getConfigKey(channelId);
    const config = this.configs.get(key);
    return config?.directory;
  }

  hasChannelWorkingDirectory(channelId: string): boolean {
    return !!this.getChannelWorkingDirectory(channelId);
  }

  formatChannelSetupMessage(channelId: string, channelName: string): string {
    const hasBaseDir = !!config.baseDirectory;
    
    let message = `🏠 **Channel Working Directory Setup**\n\n`;
    message += `Please set the default working directory for #${channelName}:\n\n`;
    
    if (hasBaseDir) {
      message += `**Options:**\n`;
      message += `• \`cwd project-name\` (relative to: \`${config.baseDirectory}\`)\n`;
      message += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
    } else {
      message += `**Usage:**\n`;
      message += `• \`cwd /path/to/project\`\n`;
      message += `• \`set directory /path/to/project\`\n\n`;
    }
    
    message += `This becomes the default for all conversations in this channel.\n`;
    message += `Individual threads can override this by mentioning me with a different \`cwd\` command.`;
    
    return message;
  }
}