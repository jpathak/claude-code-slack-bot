import bolt from '@slack/bolt';
const { App } = bolt;
type AppType = InstanceType<typeof App>;
import { ClaudeHandler } from './claude-handler.js';
// Use ClaudeMessage from our wrapper instead of SDK (SDK has compatibility issues)
import { ClaudeMessage } from './claude-cli-wrapper.js';
type SDKMessage = ClaudeMessage;
import { Logger } from './logger.js';
import { WorkingDirectoryManager } from './working-directory-manager.js';
import { FileHandler, ProcessedFile } from './file-handler.js';
import { TodoManager, Todo } from './todo-manager.js';
import { McpManager } from './mcp-manager.js';
import { permissionServer } from './permission-mcp-server.js';
import { config } from './config.js';
import { SessionDiscovery, SessionInfo } from './session-discovery.js';
import { SessionWatcher } from './session-watcher.js';
import { VerbosityManager } from './verbosity-manager.js';
import { VerbosityLevel } from './types.js';
import { TaskManager } from './task-manager.js';
import { ProjectConfig } from './project-config.js';
import { ChannelProvisioner } from './channel-provisioner.js';
import { TaskPlanner } from './task-planner.js';
import { TrelloSync } from './trello-sync.js';

// Tool activity tracker for summarizing work done
export interface ToolActivityTracker {
  reads: number;
  edits: number;
  writes: number;
  bashes: number;
  others: number;
  toolNames: Set<string>;
}

export function formatToolSummary(tracker: ToolActivityTracker): string {
  const parts: string[] = [];
  if (tracker.reads > 0) parts.push(`Read ${tracker.reads} file${tracker.reads > 1 ? 's' : ''}`);
  if (tracker.edits > 0) parts.push(`edited ${tracker.edits} file${tracker.edits > 1 ? 's' : ''}`);
  if (tracker.writes > 0) parts.push(`wrote ${tracker.writes} file${tracker.writes > 1 ? 's' : ''}`);
  if (tracker.bashes > 0) parts.push(`ran ${tracker.bashes} command${tracker.bashes > 1 ? 's' : ''}`);
  if (tracker.others > 0) parts.push(`used ${tracker.others} other tool${tracker.others > 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join(', ') : 'no tools used';
}

// Configuration constants
const SESSION_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes - delay before cleaning up session data
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes - how often to run session cleanup
const SESSION_WATCHER_POLL_MS = 30000; // 30 seconds - poll interval for session watcher
const MAX_DISPLAYED_SESSIONS = 10; // Maximum sessions to display in list
const MAX_SESSION_BUTTONS = 5; // Maximum quick-select buttons for sessions
const STATUS_UPDATE_INTERVAL_MS = 5000; // 5 seconds - throttle periodic status updates

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export class SlackHandler {
  private app: AppType;
  private claudeHandler: ClaudeHandler;
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private sessionDiscovery: SessionDiscovery;
  private sessionWatcher: SessionWatcher;
  private verbosityManager: VerbosityManager;
  private taskManager: TaskManager | null = null;
  private projectConfig: ProjectConfig | null = null;
  private channelProvisioner: ChannelProvisioner | null = null;
  private trelloSync: TrelloSync | null = null;
  private taskPlanner: TaskPlanner = new TaskPlanner();
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map(); // sessionKey -> original message info
  private currentReactions: Map<string, string> = new Map(); // sessionKey -> current emoji
  private botUserId: string | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(app: AppType, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
    this.sessionDiscovery = new SessionDiscovery();
    this.sessionWatcher = new SessionWatcher(this.sessionDiscovery, SESSION_WATCHER_POLL_MS);
    this.verbosityManager = new VerbosityManager(config.defaultVerbosity);

    // Set up handoff notification callback
    this.sessionWatcher.onHandoff(async (sessionId, slackContext) => {
      await this.notifySessionHandoff(sessionId, slackContext);
    });

    // Start the session watcher
    this.sessionWatcher.start();
  }

  /**
   * Set task-related dependencies.
   * Called after construction when task management is enabled.
   */
  setTaskDependencies(
    taskManager: TaskManager,
    projectConfig: ProjectConfig,
    channelProvisioner: ChannelProvisioner,
  ): void {
    this.taskManager = taskManager;
    this.projectConfig = projectConfig;
    this.channelProvisioner = channelProvisioner;
  }

  /**
   * Set TrelloSync reference for posting clarification comments on Trello cards.
   */
  setTrelloSync(trelloSync: TrelloSync): void {
    this.trelloSync = trelloSync;
  }

  /**
   * Notify Slack that a session was continued in CLI
   */
  private async notifySessionHandoff(
    sessionId: string,
    slackContext: { channelId: string; threadTs?: string; userId: string }
  ): Promise<void> {
    try {
      const shortId = sessionId.substring(0, 8);
      const message = `📤 *Session handoff detected*\n\nThis session (\`${shortId}...\`) was continued in the CLI.\nFurther messages here will start a new session.\n\n_Use \`continue\` to resume it again from Slack._`;

      await this.app.client.chat.postMessage({
        channel: slackContext.channelId,
        thread_ts: slackContext.threadTs,
        text: message,
      });

      this.logger.info('Sent session handoff notification', { sessionId, slackContext });
    } catch (error) {
      this.logger.error('Failed to send handoff notification', { sessionId, error });
    }
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;
    
    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);
      
      if (processedFiles.length > 0) {
        await say({
          text: `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // Check if this is a working directory command (only if there's text)
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        thread_ts,
        isDM ? user : undefined
      );

      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: `✅ Working directory set for ${context}: \`${result.resolvedPath}\``,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ ${result.error}`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a get directory command (only if there's text)
    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        isDM ? user : undefined
      );
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      
      await say({
        text: this.workingDirManager.formatDirectoryMessage(directory, context),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP info command (only if there's text)
    if (text && this.isMcpInfoCommand(text)) {
      await say({
        text: this.mcpManager.formatMcpInfo(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      if (reloaded) {
        await say({
          text: `✅ MCP configuration reloaded successfully.\n\n${this.mcpManager.formatMcpInfo()}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a verbosity set command
    if (text) {
      const verbosityLevel = this.verbosityManager.parseSetCommand(text);
      if (verbosityLevel) {
        const isDM = channel.startsWith('D');
        this.verbosityManager.setVerbosity(channel, verbosityLevel, thread_ts, isDM ? user : undefined);
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: this.verbosityManager.formatVerbosityMessage(verbosityLevel, context),
          thread_ts: thread_ts || ts,
        });
        return;
      }
    }

    // Check if this is a verbosity get command
    if (text && this.verbosityManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const level = this.verbosityManager.getVerbosity(channel, thread_ts, isDM ? user : undefined);
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      await say({
        text: this.verbosityManager.formatVerbosityMessage(level, context),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is a thread reply for a task waiting for clarification
    if (text && thread_ts && this.taskManager) {
      const clarificationTask = this.findTaskWaitingForClarificationInThread(channel, thread_ts);
      if (clarificationTask) {
        this.logger.info('Detected thread reply for task waiting clarification', {
          taskId: clarificationTask.id,
          threadTs: thread_ts,
        });
        // Handle this as an answer to the clarification questions
        await this.handleClarificationReply(channel, clarificationTask, text, thread_ts, say);
        return;
      }
    }

    // Check if this is a continue command
    if (text && this.isContinueCommand(text)) {
      await this.handleContinueCommand(user, channel, thread_ts, ts, text, say);
      return;
    }

    // Check if this is a sessions list command
    if (text && this.isSessionsCommand(text)) {
      await this.handleSessionsCommand(user, channel, thread_ts, ts, say);
      return;
    }

    // Check if we have a working directory set
    const isDM = channel.startsWith('D');
    let workingDirectory = this.workingDirManager.getExplicitWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    // Fallback: check project config for auto-provisioned channels
    if (!workingDirectory && this.projectConfig) {
      const mapping = this.projectConfig.getByChannelId(channel);
      if (mapping) {
        workingDirectory = mapping.projectPath;
      }
    }

    // Final fallback: base directory
    if (!workingDirectory) {
      workingDirectory = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        isDM ? user : undefined
      );
    }

    // Working directory is always required
    if (!workingDirectory) {
      let errorMessage = `⚠️ No working directory set. `;
      
      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        // No channel default set
        errorMessage += `Please set a default working directory for this channel first using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`cwd project-name\` or \`cwd /absolute/path\`\n\n`;
          errorMessage += `Base directory: \`${config.baseDirectory}\``;
        } else {
          errorMessage += `\`cwd /path/to/directory\``;
        }
      } else if (thread_ts) {
        // In thread but no thread-specific directory
        errorMessage += `You can set a thread-specific working directory using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`@claudebot cwd project-name\` or \`@claudebot cwd /absolute/path\``;
        } else {
          errorMessage += `\`@claudebot cwd /path/to/directory\``;
        }
      } else {
        errorMessage += `Please set one first using:\n\`cwd /path/to/directory\``;
      }
      
      await say({
        text: errorMessage,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);
    
    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });
    
    // Cancel any existing request for this conversation
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      this.logger.debug('Cancelling existing request for session', { sessionKey });
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      // Prepare the prompt with file attachments
      const finalPrompt = processedFiles.length > 0 
        ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
        : text || '';

      this.logger.info('Sending query to Claude Code SDK', { 
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''), 
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      // Send initial status message
      const statusResult = await say({
        text: '🤔 *Thinking...*',
        thread_ts: thread_ts || ts,
      });
      statusMessageTs = statusResult.ts;

      // Add thinking reaction to original message (but don't spam if already set)
      await this.updateMessageReaction(sessionKey, 'thinking_face');
      
      // Create Slack context for permission prompts
      const slackContext = {
        channel,
        threadTs: thread_ts,
        user
      };

      // Resolve verbosity for this context
      const isDMForVerbosity = channel.startsWith('D');
      const verbosity = this.verbosityManager.getVerbosity(
        channel, thread_ts, isDMForVerbosity ? user : undefined
      );

      // Initialize tool activity tracker
      const toolTracker: ToolActivityTracker = {
        reads: 0, edits: 0, writes: 0, bashes: 0, others: 0,
        toolNames: new Set<string>(),
      };

      // Track last status update time for throttling periodic updates
      let lastStatusUpdateMs = 0;

      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        if (message.type === 'assistant' && message.message) {
          // Check if this is a tool use message
          const content = message.message.content || [];
          const hasToolUse = content.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            // Update reaction to show working
            await this.updateMessageReaction(sessionKey, 'gear');

            // Track tool usage for summary
            for (const part of content) {
              if (part.type === 'tool_use' && part.name) {
                toolTracker.toolNames.add(part.name);
                switch (part.name) {
                  case 'Read': toolTracker.reads++; break;
                  case 'Edit': case 'MultiEdit': toolTracker.edits++; break;
                  case 'Write': toolTracker.writes++; break;
                  case 'Bash': toolTracker.bashes++; break;
                  case 'TodoWrite': break; // Don't count TodoWrite as "other"
                  default: toolTracker.others++; break;
                }
              }
            }

            // Periodically update status message with progress summary
            // when individual tool messages are not being shown
            const now = Date.now();
            if (verbosity !== 'verbose' && statusMessageTs && (now - lastStatusUpdateMs) >= STATUS_UPDATE_INTERVAL_MS) {
              lastStatusUpdateMs = now;
              const progressSummary = formatToolSummary(toolTracker);
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: `⚙️ *Working...* (${progressSummary})`,
              });
            } else if (lastStatusUpdateMs === 0 && statusMessageTs) {
              // First tool use — update from "Thinking" to "Working"
              lastStatusUpdateMs = now;
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Working...*',
              });
            }

            // Check for TodoWrite tool and handle it specially
            const todoTool = content.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            // Only show todo updates in normal and verbose modes
            if (todoTool && verbosity !== 'minimal') {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say);
            }

            // Only send individual tool use messages in verbose mode
            if (verbosity === 'verbose') {
              const toolContent = this.formatToolUse(content);
              if (toolContent) {
                await say({
                  text: toolContent,
                  thread_ts: thread_ts || ts,
                });
              }
            }
          } else {
            // Handle regular text content
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);

              // Only send intermediate text in normal and verbose modes
              if (verbosity !== 'minimal') {
                const formatted = this.formatMessage(content, false);
                await say({
                  text: formatted,
                  thread_ts: thread_ts || ts,
                });
              }
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            hasResult: message.subtype === 'success' && !!(message as any).result,
            totalCost: (message as any).total_cost_usd,
            duration: (message as any).duration_ms,
          });

          // Final result is always sent regardless of verbosity
          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              const formatted = this.formatMessage(finalResult, true);
              await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });
            }
          }
        }
      }

      // Build completion status based on verbosity
      const toolSummaryStr = formatToolSummary(toolTracker);
      const hasToolActivity = toolTracker.toolNames.size > 0;

      if (verbosity === 'minimal' && hasToolActivity) {
        // In minimal mode, append tool summary to the status line
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: `✅ *Done* — ${toolSummaryStr}`,
          });
        }
      } else if (verbosity === 'normal' && hasToolActivity) {
        // In normal mode, update status and send a consolidated summary message
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '✅ *Task completed*',
          });
        }
        await say({
          text: `🔧 *Tools used:* ${toolSummaryStr}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        // In verbose mode (or no tool activity), just mark completed
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '✅ *Task completed*',
          });
        }
      }

      // Update reaction to show completion
      await this.updateMessageReaction(sessionKey, 'white_check_mark');

      // Update session watcher mod time so it doesn't think CLI took over
      if (session?.sessionId && workingDirectory) {
        this.sessionWatcher.updateModTime(session.sessionId);
      }

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);
        
        // Update status to error
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '❌ *Error occurred*',
          });
        }

        // Update reaction to show error
        await this.updateMessageReaction(sessionKey, 'x');
        
        await say({
          text: `Error: ${error.message || 'Something went wrong'}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });
        
        // Update status to cancelled
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '⏹️ *Cancelled*',
          });
        }

        // Update reaction to show cancellation
        await this.updateMessageReaction(sessionKey, 'stop_button');
      }

      // Clean up temporary files in case of error too
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeControllers.delete(sessionKey);
      
      // Clean up todo tracking if session ended
      if (session?.sessionId) {
        // Don't immediately clean up - keep todos visible for a while
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, SESSION_CLEANUP_DELAY_MS);
      }
    }
  }

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message?.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];
    
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;
        
        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            // Handle TodoWrite separately - don't include in regular tool output
            return this.handleTodoWrite(input);
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }
    
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    
    let result = `📝 *Editing \`${filePath}\`*\n`;
    
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    
    return result;
  }

  private formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);
    
    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    return `🔧 *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    // TodoWrite tool doesn't produce visible output - handled separately
    return '';
  }

  private async handleTodoUpdate(
    input: any, 
    sessionKey: string, 
    sessionId: string | undefined, 
    channel: string, 
    threadTs: string, 
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);
    
    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);
      
      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);
      
      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);
      
      if (existingTodoMessageTs) {
        // Update existing todo message
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            text: todoList,
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          // If update fails, create a new message
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        // Create new todo message
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({
          text: `🔄 *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });
      }

      // Update reaction based on overall progress
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string, 
    channel: string, 
    threadTs: string, 
    sessionKey: string, 
    say: any
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });
    
    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // Check if we're already showing this emoji
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    try {
      // Remove the current reaction if it exists
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
          this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
        } catch (error) {
          this.logger.debug('Failed to remove previous reaction (might not exist)', { 
            sessionKey, 
            emoji: currentEmoji,
            error: (error as any).message 
          });
        }
      }

      // Add the new reaction
      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      // Track the current reaction
      this.currentReactions.set(sessionKey, emoji);

      this.logger.debug('Updated message reaction', { 
        sessionKey, 
        emoji, 
        previousEmoji: currentEmoji,
        channel: originalMessage.channel, 
        ts: originalMessage.ts 
      });
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = 'white_check_mark'; // All tasks completed
    } else if (inProgress > 0) {
      emoji = 'arrows_counterclockwise'; // Tasks in progress
    } else {
      emoji = 'clipboard'; // Tasks pending
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  /**
   * Check if a channel is an auto-provisioned project channel.
   */
  private isProjectChannel(channelId: string): boolean {
    if (!this.projectConfig) return false;
    return !!this.projectConfig.getByChannelId(channelId);
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^(mcp|servers?)(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^(mcp|servers?)\s+(reload|refresh)$/i.test(text.trim());
  }

  private isContinueCommand(text: string): boolean {
    // Match: continue, --continue, -c, continue <session-id>
    return /^(--?continue|continue|-c)(\s+\S+)?$/i.test(text.trim());
  }

  private isSessionsCommand(text: string): boolean {
    // Match: sessions, list sessions, session list
    return /^(sessions?|list\s+sessions?|sessions?\s+list)(\?)?$/i.test(text.trim());
  }

  private extractSessionIdFromContinue(text: string): string | null {
    const match = text.trim().match(/^(?:--?continue|continue|-c)\s+(\S+)$/i);
    return match ? match[1] : null;
  }

  private async handleContinueCommand(
    user: string,
    channel: string,
    thread_ts: string | undefined,
    ts: string,
    text: string,
    say: any
  ): Promise<void> {
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getExplicitWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    if (!workingDirectory) {
      await say({
        text: `⚠️ No working directory set for this conversation. Please set one first using \`cwd /path/to/directory\` before using \`continue\`.\n\n_Note: The \`continue\` command requires an explicitly set directory, not the base directory fallback._`,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if Claude projects directory exists
    if (!this.sessionDiscovery.isClaudeConfigured()) {
      await say({
        text: `⚠️ Claude Code is not configured on this machine.\nNo sessions found in \`~/.claude/projects/\`.`,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if a specific session ID was provided
    const specificSessionId = this.extractSessionIdFromContinue(text);

    try {
      let sessionToResume: SessionInfo | null = null;

      if (specificSessionId) {
        // Try to find the specific session
        sessionToResume = await this.sessionDiscovery.getSessionById(specificSessionId, workingDirectory);
        if (!sessionToResume) {
          await say({
            text: `❌ Session \`${specificSessionId}\` not found for working directory \`${workingDirectory}\`.\n\nUse \`sessions\` to see available sessions.`,
            thread_ts: thread_ts || ts,
          });
          return;
        }
      } else {
        // Get the latest session
        sessionToResume = await this.sessionDiscovery.getLatestSession(workingDirectory);
        if (!sessionToResume) {
          await say({
            text: `ℹ️ No previous sessions found for \`${workingDirectory}\`.\n\nStart a new conversation by sending a message.`,
            thread_ts: thread_ts || ts,
          });
          return;
        }
      }

      // Create or update the session in ClaudeHandler
      const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);
      let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);

      if (!session) {
        session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
      }

      // Set the session ID to the one we're resuming
      session.sessionId = sessionToResume.sessionId;
      session.isResumed = true;
      session.resumedFrom = sessionToResume.owner || 'cli';
      session.workingDirectory = workingDirectory;

      // Set ownership to Slack
      this.sessionDiscovery.setSessionOwnership(sessionToResume.sessionId, workingDirectory, {
        channelId: channel,
        threadTs: thread_ts,
        userId: user,
      });

      // Start watching the session for external modifications
      this.sessionWatcher.watchSession(sessionToResume.sessionId, workingDirectory, {
        channelId: channel,
        threadTs: thread_ts,
        userId: user,
      });

      const shortId = sessionToResume.sessionId.substring(0, 8);
      const timeAgo = this.formatTimeAgo(sessionToResume.lastActivity);
      const sourceBadge = sessionToResume.owner === 'slack' ? '📱 Slack' : '💻 CLI';

      let resumeMessage = `📥 *Resuming session* \`${shortId}...\`\n\n`;
      resumeMessage += `• *Last active:* ${timeAgo}\n`;
      resumeMessage += `• *Messages:* ${sessionToResume.messageCount}\n`;
      resumeMessage += `• *Source:* ${sourceBadge}\n`;
      resumeMessage += `• *Working directory:* \`${workingDirectory}\`\n\n`;
      resumeMessage += `_"${sessionToResume.summary}"_\n\n`;
      resumeMessage += `You can now continue the conversation. Send a message to interact with this session.`;

      await say({
        text: resumeMessage,
        thread_ts: thread_ts || ts,
      });

      this.logger.info('Resumed session', {
        sessionId: sessionToResume.sessionId,
        workingDirectory,
        messageCount: sessionToResume.messageCount,
        user,
        channel,
      });
    } catch (error) {
      this.logger.error('Error handling continue command', { error });
      await say({
        text: `❌ Error resuming session: ${(error as Error).message}`,
        thread_ts: thread_ts || ts,
      });
    }
  }

  private async handleSessionsCommand(
    user: string,
    channel: string,
    thread_ts: string | undefined,
    ts: string,
    say: any
  ): Promise<void> {
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getExplicitWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    if (!workingDirectory) {
      await say({
        text: `⚠️ No working directory set for this conversation. Please set one first using \`cwd /path/to/directory\`.\n\n_Note: The \`sessions\` command requires an explicitly set directory, not the base directory fallback._`,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    if (!this.sessionDiscovery.isClaudeConfigured()) {
      await say({
        text: `⚠️ Claude Code is not configured on this machine.\nNo sessions found in \`~/.claude/projects/\`.`,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    try {
      const sessions = await this.sessionDiscovery.listSessions(workingDirectory);

      if (sessions.length === 0) {
        await say({
          text: `ℹ️ No sessions found for \`${workingDirectory}\`.\n\nStart a new conversation by sending a message.`,
          thread_ts: thread_ts || ts,
        });
        return;
      }

      // Format sessions list with interactive buttons
      const displaySessions = sessions.slice(0, MAX_DISPLAYED_SESSIONS);

      let message = `📋 *Available Sessions* for \`${workingDirectory}\`\n\n`;

      for (let i = 0; i < displaySessions.length; i++) {
        const session = displaySessions[i];
        message += `${i + 1}. ${this.sessionDiscovery.formatSessionForSlack(session)}\n\n`;
      }

      if (sessions.length > MAX_DISPLAYED_SESSIONS) {
        message += `\n_...and ${sessions.length - MAX_DISPLAYED_SESSIONS} more sessions_\n`;
      }

      message += `\n*To resume a session:*\n`;
      message += `• \`continue\` - Resume the most recent session\n`;
      message += `• \`continue <id>\` - Resume a specific session by ID\n`;

      // Create interactive buttons for the top 5 sessions
      const blocks: any[] = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: message,
          },
        },
      ];

      // Add buttons for quick session selection (top 5)
      const buttonSessions = displaySessions.slice(0, MAX_SESSION_BUTTONS);
      if (buttonSessions.length > 0) {
        const buttons = buttonSessions.map((session, index) => ({
          type: 'button',
          text: {
            type: 'plain_text',
            text: `${index + 1}. ${session.sessionId.substring(0, 8)}`,
            emoji: true,
          },
          value: `${session.sessionId}|${workingDirectory}`,
          action_id: `resume_session_${index}`,
        }));

        blocks.push({
          type: 'actions',
          elements: buttons,
        });
      }

      await say({
        text: message, // Fallback for notifications
        blocks,
        thread_ts: thread_ts || ts,
      });

      this.logger.info('Listed sessions', {
        workingDirectory,
        count: sessions.length,
        displayedCount: displaySessions.length,
      });
    } catch (error) {
      this.logger.error('Error handling sessions command', { error });
      await say({
        text: `❌ Error listing sessions: ${(error as Error).message}`,
        thread_ts: thread_ts || ts,
      });
    }
  }

  /**
   * Public: handle a status transition triggered externally (e.g. from Trello).
   * Posts updates to the project's Slack channel and triggers appropriate workflows.
   */
  async handleExternalStatusTransition(
    channelId: string,
    itemId: string,
    newStatus: string,
    projectPath: string,
    oldStatus?: string,
  ): Promise<void> {
    // Skip notifications for Claude Code-driven changes
    if (this.taskManager) {
      const store = this.taskManager.getStore(channelId);
      const currentItem = store.findItem(itemId);
      if (currentItem?.executingAgent === 'claude-code') {
        this.logger.info('Skipping Slack notification for claude-code driven change', { itemId });
        return;
      }
    }

    const makeSay = (channelId: string, threadTs: string) => {
      return async (msg: { text: string; thread_ts?: string }) => {
        return await this.app.client.chat.postMessage({
          channel: channelId,
          thread_ts: msg.thread_ts ?? threadTs,
          text: msg.text,
        });
      };
    };

    this.logger.info('handleExternalStatusTransition called', {
      channelId, itemId, newStatus, oldStatus, projectPath,
    });

    // CRITICAL: Always sync local status to match the Trello-initiated change.
    // The inbound sync may skip local status updates when executingAgent is set
    // (to prevent reverting agent-driven changes). But when we reach THIS handler,
    // we know the transition was initiated externally (via Trello board), so we
    // must ensure the local status matches. Otherwise, the outbound sync will
    // push the stale local status back to Trello, reverting the user's card move.
    if (this.taskManager) {
      const syncStore = this.taskManager.getStore(channelId);
      const syncItem = syncStore.findItem(itemId);
      if (syncItem && syncItem.status !== newStatus) {
        this.logger.info('Syncing local status to match Trello-initiated transition', {
          itemId, localStatus: syncItem.status, trelloStatus: newStatus,
        });
        syncStore.moveItem(itemId, newStatus as any);
      }
    }

    if (newStatus === 'planning') {
      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text: `📐 Task *#${itemId}* moved to *Planning* (via board). Starting auto-planning...`,
      });
      const threadTs = result.ts!;
      await this.triggerTaskPlanning(channelId, itemId, threadTs, makeSay(channelId, threadTs));
    } else if (newStatus === 'clarification_needed') {
      // Task moved to clarification_needed via board - post the questions if available
      if (!this.taskManager) return;
      const store = this.taskManager.getStore(channelId);
      const item = store.findItem(itemId);
      if (item && item.questions && item.questions.length > 0) {
        const questionList = item.questions.map((q, i) => `  ${i + 1}. ${q}`).join('\n');
        const result = await this.app.client.chat.postMessage({
          channel: channelId,
          text: `❓ Task *#${itemId}* moved to *Clarification Needed* (via board):\n${questionList}\n\nReply in this thread or comment on the Trello card.`,
        });
        // Track the thread for clarification replies
        if (result.ts) {
          store.updateItem(itemId, { clarificationThreadTs: result.ts });
        }
        // Also post clarification questions on the Trello card
        if (this.trelloSync) {
          this.trelloSync.postClarificationComment(projectPath, itemId, item.questions).catch(err => {
            this.logger.warn('Failed to post Trello clarification comment', { itemId, error: err });
          });
        }
      } else {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: `❓ Task *#${itemId}* moved to *Clarification Needed* (via board). Reply with clarification when ready.`,
        });
      }
    } else if (newStatus === 'ready') {
      // Task moved to "ready" via board - prompt user to approve
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `📋 Task *#${itemId}* moved to *Ready to Execute* (via board). Use \`go ${itemId}\` to approve and start implementation.`,
      });
    } else if (newStatus === 'in_progress') {
      // Direct move to in_progress via board triggers implementation
      // Agent coordination: check if another agent has claimed this task
      if (this.taskManager) {
        const implStore = this.taskManager.getStore(channelId);
        const implItem = implStore.findItem(itemId);
        if (implItem?.executingAgent && implItem.executingAgent !== 'slack-bot') {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: `⚠️ Task *#${itemId}* is currently being executed by *${implItem.executingAgent}*. Slack bot will not start implementation.`,
          });
          return;
        }
      }

      const isRetry = oldStatus === 'review';
      const wasWaitingClarification = oldStatus === 'clarification_needed';
      let label = 'Starting implementation';
      let emoji = '🚀';

      if (isRetry) {
        label = 'Retrying implementation';
        emoji = '🔄';
      } else if (wasWaitingClarification) {
        label = 'Starting implementation (clarification bypassed)';
        emoji = '⏭️';
      }

      const result = await this.app.client.chat.postMessage({
        channel: channelId,
        text: `${emoji} Task *#${itemId}* moved to *In Progress* (via board). ${label}...`,
      });
      const threadTs = result.ts!;
      await this.triggerTaskImplementation(channelId, itemId, threadTs, makeSay(channelId, threadTs), isRetry);
    } else if (newStatus === 'review') {
      // Task moved to review via board (e.g., manual completion)
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `👀 Task *#${itemId}* moved to *Review* (via board). Use \`approve ${itemId}\` to mark as done.`,
      });
    } else if (newStatus === 'done') {
      // Task marked as done via board
      await this.app.client.chat.postMessage({
        channel: channelId,
        text: `✅ Task *#${itemId}* marked as *Done* (via board).`,
      });
    }
  }

  /**
   * Trigger automatic task planning via Claude.
   * Sends a planning prompt to Claude, saves specs, and applies the result.
   */
  private async triggerTaskPlanning(
    channel: string,
    itemId: string,
    threadTs: string,
    say: any,
  ): Promise<void> {
    if (!this.taskManager) return;

    const store = this.taskManager.getStore(channel);
    const planResult = await this.taskPlanner.processNewTask(store, itemId);
    if (!planResult) return;

    // Agent coordination: check if another agent is already executing this task
    const currentItem = store.findItem(itemId);
    if (currentItem?.executingAgent && currentItem.executingAgent !== 'slack-bot') {
      this.logger.warn('Task claimed by another agent, skipping planning', {
        itemId, executingAgent: currentItem.executingAgent,
      });
      return;
    }

    // Claim the task for this agent
    store.updateItem(itemId, { executingAgent: 'slack-bot' });

    await say({
      text: `📐 Planning task *#${planResult.item.id}*: generating acceptance criteria...`,
      thread_ts: threadTs,
    });

    const mapping = this.projectConfig?.getByChannelId(channel);
    const workingDirectory = mapping?.projectPath;

    const planningUser = 'SYSTEM_PLANNER';
    const session = this.claudeHandler.createSession(planningUser, channel, threadTs);

    let planningOutput = '';
    const abortController = new AbortController();
    const controllerKey = `SYSTEM_PLANNER-${channel}-${threadTs}`;
    this.activeControllers.set(controllerKey, abortController);

    const tracker: ToolActivityTracker = { reads: 0, edits: 0, writes: 0, bashes: 0, others: 0, toolNames: new Set() };
    let statusMessageTs: string | undefined;
    let lastStatusUpdateMs = 0;
    let timedOut = false;

    // Timeout watchdog
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      this.logger.warn('Planning timed out', { itemId, timeoutMs: config.tasks.planningTimeoutMs });
      abortController.abort();
    }, config.tasks.planningTimeoutMs);

    // Post initial status message that we'll update with progress
    const statusResult = await say({
      text: '🤔 *Analyzing task...*',
      thread_ts: threadTs,
    });
    statusMessageTs = statusResult?.ts;

    try {
      for await (const message of this.claudeHandler.streamQuery(
        planResult.planningPrompt,
        session,
        abortController,
        workingDirectory,
      )) {
        if (message.type === 'assistant' && message.message) {
          const content = message.message.content || [];
          const hasToolUse = content.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            // Track tool usage
            for (const part of content) {
              if (part.type === 'tool_use' && (part as any).name) {
                const name = (part as any).name;
                tracker.toolNames.add(name);
                switch (name) {
                  case 'Read': tracker.reads++; break;
                  case 'Edit': case 'MultiEdit': tracker.edits++; break;
                  case 'Write': tracker.writes++; break;
                  case 'Bash': tracker.bashes++; break;
                  default: tracker.others++; break;
                }
              }
            }

            // Update progress status periodically
            const now = Date.now();
            if (statusMessageTs && (now - lastStatusUpdateMs) >= STATUS_UPDATE_INTERVAL_MS) {
              lastStatusUpdateMs = now;
              const progress = formatToolSummary(tracker);
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: `⚙️ *Planning...* (${progress})`,
              });
            } else if (lastStatusUpdateMs === 0 && statusMessageTs) {
              lastStatusUpdateMs = now;
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Exploring codebase...*',
              });
            }
          }

          for (const part of content) {
            if ((part as any).type === 'text' && (part as any).text) {
              planningOutput += (part as any).text;
            }
          }
        } else if (message.type === 'result' && message.subtype === 'success' && (message as any).result) {
          const resultText = (message as any).result;
          if (typeof resultText === 'string' && resultText.trim()) {
            if (resultText.includes('## Acceptance Criteria') || resultText.includes('## Questions')) {
              planningOutput = resultText;
            } else if (!planningOutput.trim()) {
              planningOutput = resultText;
            }
          }
        }
      }

      // Check if aborted (e.g. timeout) after the loop completes without throwing
      if (abortController.signal.aborted) {
        throw new Error(timedOut ? 'Planning timed out' : 'Planning aborted');
      }
    } catch (err) {
      this.logger.error('Planning query failed', { itemId, error: err });

      // Move task back to backlog so it can be re-planned
      const failedItem = store.findItem(itemId);
      if (failedItem && failedItem.status === 'planning') {
        store.moveItem(itemId, 'backlog');
      }
      // Release agent claim on failure
      store.updateItem(itemId, { executingAgent: undefined });

      const errMsg = timedOut
        ? `Auto-planning for task *#${itemId}* timed out after ${Math.round(config.tasks.planningTimeoutMs / 60000)} minutes. Task moved back to *Backlog*.`
        : `Auto-planning for task *#${itemId}* failed: ${(err as Error).message || 'Unknown error'}. Task moved back to *Backlog*.`;

      if (statusMessageTs) {
        await this.app.client.chat.update({ channel, ts: statusMessageTs, text: '❌ *Planning failed*' });
      }
      await say({ text: `⚠️ ${errMsg}`, thread_ts: threadTs });
      return;
    } finally {
      clearTimeout(timeoutHandle);
      this.activeControllers.delete(controllerKey);
    }

    // Update status to done
    if (statusMessageTs) {
      const progress = tracker.toolNames.size > 0 ? ` — ${formatToolSummary(tracker)}` : '';
      await this.app.client.chat.update({ channel, ts: statusMessageTs, text: `✅ *Planning complete*${progress}` });
    }

    if (!planningOutput.trim()) {
      this.logger.warn('Planning returned empty output, moving task to backlog', { itemId });
      // Move task back to backlog so it can be re-planned
      store.moveItem(itemId, 'backlog');
      store.updateItem(itemId, { executingAgent: undefined });
      await say({
        text: `⚠️ Planning for task *#${itemId}* returned no output. Task moved back to *Backlog*.`,
        thread_ts: threadTs,
      });
      return;
    }

    // Apply planning result (this also saves the spec to .specs/<id>/plan.md)
    const updated = await this.taskPlanner.applyPlanningResult(store, itemId, planningOutput);
    if (!updated) {
      this.logger.error('applyPlanningResult returned null, moving task to backlog', { itemId });
      // Move task back to backlog so it can be re-planned
      store.moveItem(itemId, 'backlog');
      store.updateItem(itemId, { executingAgent: undefined });
      await say({
        text: `⚠️ Failed to apply planning result for task *#${itemId}*. Task moved back to *Backlog*.`,
        thread_ts: threadTs,
      });
      return;
    }

    // Release agent claim after planning completes
    store.updateItem(itemId, { executingAgent: undefined });

    if (updated.status === 'clarification_needed' && updated.questions?.length) {
      // Track the thread where clarification is being requested
      store.updateItem(updated.id, { clarificationThreadTs: threadTs });

      const questionList = updated.questions.map((q, i) => `  ${i + 1}. ${q}`).join('\n');
      await say({
        text: `❓ Task *#${updated.id}* needs clarification:\n${questionList}\n\nReply in this thread with your answers, or comment on the Trello card.`,
        thread_ts: threadTs,
      });

      // Also post clarification questions as a comment on the Trello card
      if (this.trelloSync && workingDirectory) {
        this.trelloSync.postClarificationComment(workingDirectory, updated.id, updated.questions).catch(err => {
          this.logger.warn('Failed to post Trello clarification comment', { itemId: updated.id, error: err });
        });
      }
    } else {
      const acCount = updated.acceptanceCriteria?.length ?? 0;
      const specPath = workingDirectory ? `.specs/${updated.id}/plan.md` : '';
      // Task stays in "ready" state - user must explicitly approve with "go" command
      await say({
        text: `✅ Task *#${updated.id}* is *Ready to Execute* with ${acCount} acceptance criteria.${specPath ? ` Spec saved to \`${specPath}\`.` : ''}\n\n*Review the plan, then use \`go ${updated.id}\` to start implementation.*`,
        thread_ts: threadTs,
      });
      // Note: Task remains in "ready" state. User must explicitly run "go <id>" to approve and start implementation.
    }
  }

  /**
   * Trigger task implementation via Claude.
   * Uses spec context, saves implementation notes, moves to review when done.
   */
  private async triggerTaskImplementation(
    channel: string,
    itemId: string,
    threadTs: string,
    say: any,
    isRetry: boolean = false,
  ): Promise<void> {
    if (!this.taskManager) return;

    const store = this.taskManager.getStore(channel);
    const item = store.findItem(itemId);
    if (!item) return;

    // Agent coordination: check if another agent is already executing this task
    if (item.executingAgent && item.executingAgent !== 'slack-bot') {
      this.logger.warn('Task claimed by another agent, skipping implementation', {
        itemId, executingAgent: item.executingAgent,
      });
      await say({
        text: `⚠️ Task *#${itemId}* is currently being executed by *${item.executingAgent}*. Skipping.`,
        thread_ts: threadTs,
      });
      return;
    }

    // Claim the task for this agent
    store.updateItem(item.id, { executingAgent: 'slack-bot' });

    const mapping = this.projectConfig?.getByChannelId(channel);
    const workingDirectory = mapping?.projectPath;

    // Build implementation prompt using TaskPlanner (includes spec context)
    let implementPrompt: string;
    if (isRetry && workingDirectory) {
      implementPrompt = this.taskPlanner.generateRetryImplementationPrompt(item, workingDirectory);
    } else if (workingDirectory) {
      implementPrompt = this.taskPlanner.generateImplementationPrompt(item, workingDirectory);
    } else {
      implementPrompt = `Implement task #${item.id}: "${item.title}"\n${item.description || ''}\n\nPlease implement this task fully.`;
    }

    // Inject board context
    const boardData = store.load();
    const boardContext = this.taskPlanner.generateBoardContext(boardData);
    const fullPrompt = `${boardContext}\n\n${implementPrompt}`;

    const implUser = 'SYSTEM_IMPL';
    const session = this.claudeHandler.createSession(implUser, channel, threadTs);

    const abortController = new AbortController();
    const controllerKey = `SYSTEM_IMPL-${channel}-${threadTs}`;
    this.activeControllers.set(controllerKey, abortController);

    let lastTextOutput = '';
    const tracker: ToolActivityTracker = { reads: 0, edits: 0, writes: 0, bashes: 0, others: 0, toolNames: new Set() };
    let statusMessageTs: string | undefined;
    let lastStatusUpdateMs = 0;
    let timedOut = false;

    // Timeout watchdog
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      this.logger.warn('Implementation timed out', { itemId, timeoutMs: config.tasks.implementationTimeoutMs });
      abortController.abort();
    }, config.tasks.implementationTimeoutMs);

    // Post status message that we'll update with progress
    const statusResult = await say({
      text: `⚙️ *Implementing task #${item.id}...*`,
      thread_ts: threadTs,
    });
    statusMessageTs = statusResult?.ts;

    try {
      for await (const message of this.claudeHandler.streamQuery(
        fullPrompt,
        session,
        abortController,
        workingDirectory,
      )) {
        if (message.type === 'assistant' && message.message) {
          const content = message.message.content || [];
          const hasToolUse = content.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            // Track tool usage
            for (const part of content) {
              if (part.type === 'tool_use' && (part as any).name) {
                const name = (part as any).name;
                tracker.toolNames.add(name);
                switch (name) {
                  case 'Read': tracker.reads++; break;
                  case 'Edit': case 'MultiEdit': tracker.edits++; break;
                  case 'Write': tracker.writes++; break;
                  case 'Bash': tracker.bashes++; break;
                  default: tracker.others++; break;
                }
              }
            }

            // Update progress status periodically
            const now = Date.now();
            if (statusMessageTs && (now - lastStatusUpdateMs) >= STATUS_UPDATE_INTERVAL_MS) {
              lastStatusUpdateMs = now;
              const progress = formatToolSummary(tracker);
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: `⚙️ *Implementing task #${item.id}...* (${progress})`,
              });
            } else if (lastStatusUpdateMs === 0 && statusMessageTs) {
              lastStatusUpdateMs = now;
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: `⚙️ *Implementing task #${item.id}...* (working)`,
              });
            }
          } else {
            // Post text responses to the thread so user can follow along
            const textParts = content
              .filter((part: any) => part.type === 'text' && part.text)
              .map((part: any) => part.text);
            const textContent = textParts.join('');
            if (textContent.trim()) {
              await say({
                text: this.formatMessage(textContent, false),
                thread_ts: threadTs,
              });
            }
          }

          for (const part of content) {
            if ((part as any).type === 'text' && (part as any).text) {
              lastTextOutput += (part as any).text;
            }
          }
        } else if (message.type === 'result' && message.subtype === 'success' && (message as any).result) {
          const resultText = (message as any).result;
          if (typeof resultText === 'string' && resultText.trim()) {
            lastTextOutput += '\n\n' + resultText;
          }
        }
      }

      // Check if aborted (e.g. timeout) after the loop completes without throwing
      if (abortController.signal.aborted) {
        throw new Error(timedOut ? 'Implementation timed out' : 'Implementation aborted');
      }
    } catch (err) {
      this.logger.error('Implementation query failed', { itemId, error: err });

      // Move task back to ready so it can be retried
      const currentItem = store.findItem(itemId);
      if (currentItem && currentItem.status === 'in_progress') {
        store.moveItem(itemId, 'ready');
      }
      // Release agent claim on failure
      store.updateItem(itemId, { executingAgent: undefined });

      const errMsg = timedOut
        ? `Implementation of task *#${item.id}* timed out after ${Math.round(config.tasks.implementationTimeoutMs / 60000)} minutes. Task moved back to *Ready*.`
        : `Implementation of task *#${item.id}* encountered an error: ${(err as Error).message || 'Unknown error'}. Task moved back to *Ready*.`;

      if (statusMessageTs) {
        await this.app.client.chat.update({ channel, ts: statusMessageTs, text: `❌ *Implementation of task #${item.id} failed*` });
      }
      await say({ text: `⚠️ ${errMsg}`, thread_ts: threadTs });
      return;
    } finally {
      clearTimeout(timeoutHandle);
      this.activeControllers.delete(controllerKey);
    }

    // Save implementation notes to spec dir
    if (workingDirectory && lastTextOutput.trim()) {
      this.taskPlanner.saveImplementationSpec(workingDirectory, item, lastTextOutput);
    }

    // Move to review and release agent claim
    store.moveItem(item.id, 'review');
    store.updateItem(item.id, { executingAgent: undefined });

    // Update status message with final summary
    const toolSummary = tracker.toolNames.size > 0 ? ` — ${formatToolSummary(tracker)}` : '';
    if (statusMessageTs) {
      await this.app.client.chat.update({
        channel,
        ts: statusMessageTs,
        text: `✅ *Task #${item.id} implementation complete*${toolSummary}`,
      });
    }

    await say({
      text: `👀 Task *#${item.id}* moved to *Review*. Use \`approve ${item.id}\` to mark as done.`,
      thread_ts: threadTs,
    });
  }

  private formatTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minutes ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 7) return `${diffDays} days ago`;

    return date.toLocaleDateString();
  }

  /**
   * Find a task that is waiting for clarification in a specific thread.
   * Returns the task if found, null otherwise.
   */
  private findTaskWaitingForClarificationInThread(
    channel: string,
    threadTs: string,
  ): import('./types.js').TaskItem | null {
    if (!this.taskManager) return null;

    const store = this.taskManager.getStore(channel);
    const items = store.getItems();

    // Find a task in clarification_needed state that is associated with this thread
    const clarificationTask = items.find(
      item => item.status === 'clarification_needed' && item.clarificationThreadTs === threadTs
    );

    return clarificationTask || null;
  }

  /**
   * Handle a thread reply as a clarification answer for a task.
   * Records the answer, clears questions, and re-triggers planning.
   * If re-planning yields no more questions, automatically starts implementation.
   */
  private async handleClarificationReply(
    channel: string,
    task: import('./types.js').TaskItem,
    answerText: string,
    threadTs: string,
    say: any,
  ): Promise<void> {
    if (!this.taskManager) return;

    const store = this.taskManager.getStore(channel);

    // Clear questions, append answer to description, and move back to planning
    const updated = store.updateItem(task.id, {
      questions: [],
      status: 'planning',
      description: (task.description || '') + `\n\n**Answer:** ${answerText}`,
      clarificationThreadTs: undefined, // Clear the thread association
    });

    if (updated) {
      await say({
        text: `💬 Answer recorded for task *#${updated.id}*. Re-planning with new context...`,
        thread_ts: threadTs,
      });

      // Re-trigger planning with the new answer context
      // After re-planning completes, if no more questions, auto-start implementation
      this.triggerTaskPlanningWithAutoImplement(channel, updated.id, threadTs, say).catch(err => {
        this.logger.error('Re-planning failed after thread reply', { itemId: updated.id, error: err });
        const currentItem = store.findItem(updated.id);
        if (currentItem && currentItem.status === 'planning') {
          store.moveItem(updated.id, 'backlog');
        }
      });
    }
  }

  /**
   * Handle a clarification reply from a Trello card comment.
   * Creates a new Slack thread and re-triggers planning with the answer.
   */
  async handleTrelloClarificationReply(
    channelId: string,
    itemId: string,
    answerText: string,
    projectPath: string,
  ): Promise<void> {
    if (!this.taskManager) return;

    const store = this.taskManager.getStore(channelId);
    const task = store.findItem(itemId);
    if (!task) {
      this.logger.warn('Trello clarification reply for unknown task', { itemId });
      return;
    }

    // Post a new message in Slack to track the re-planning
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text: `💬 Clarification received for task *#${itemId}* (via Trello comment). Re-planning...`,
    });
    const threadTs = result.ts!;

    const say = async (msg: { text: string; thread_ts?: string }) => {
      return await this.app.client.chat.postMessage({
        channel: channelId,
        thread_ts: msg.thread_ts ?? threadTs,
        text: msg.text,
      });
    };

    // Reuse existing clarification reply logic
    await this.handleClarificationReply(channelId, task, answerText, threadTs, say);
  }

  /**
   * Trigger planning and automatically start implementation if no questions remain.
   * Used after clarification is provided to streamline the workflow.
   */
  private async triggerTaskPlanningWithAutoImplement(
    channel: string,
    itemId: string,
    threadTs: string,
    say: any,
  ): Promise<void> {
    if (!this.taskManager) return;

    const store = this.taskManager.getStore(channel);
    const planResult = await this.taskPlanner.processNewTask(store, itemId);
    if (!planResult) return;

    // Agent coordination: check if another agent is already executing this task
    const autoImplCurrentItem = store.findItem(itemId);
    if (autoImplCurrentItem?.executingAgent && autoImplCurrentItem.executingAgent !== 'slack-bot') {
      this.logger.warn('Task claimed by another agent, skipping re-planning', {
        itemId, executingAgent: autoImplCurrentItem.executingAgent,
      });
      return;
    }

    // Claim the task for this agent
    store.updateItem(itemId, { executingAgent: 'slack-bot' });

    await say({
      text: `📐 Re-planning task *#${planResult.item.id}* with clarification...`,
      thread_ts: threadTs,
    });

    const mapping = this.projectConfig?.getByChannelId(channel);
    const workingDirectory = mapping?.projectPath;

    const planningUser = 'SYSTEM_PLANNER';
    const session = this.claudeHandler.createSession(planningUser, channel, threadTs);

    let planningOutput = '';
    const abortController = new AbortController();
    const controllerKey = `SYSTEM_PLANNER-${channel}-${threadTs}`;
    this.activeControllers.set(controllerKey, abortController);

    const tracker: ToolActivityTracker = { reads: 0, edits: 0, writes: 0, bashes: 0, others: 0, toolNames: new Set() };
    let statusMessageTs: string | undefined;
    let lastStatusUpdateMs = 0;
    let timedOut = false;

    // Timeout watchdog
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      this.logger.warn('Re-planning timed out', { itemId, timeoutMs: config.tasks.planningTimeoutMs });
      abortController.abort();
    }, config.tasks.planningTimeoutMs);

    // Post initial status message that we'll update with progress
    const statusResult = await say({
      text: '🤔 *Analyzing with clarification...*',
      thread_ts: threadTs,
    });
    statusMessageTs = statusResult?.ts;

    try {
      for await (const message of this.claudeHandler.streamQuery(
        planResult.planningPrompt,
        session,
        abortController,
        workingDirectory,
      )) {
        if (message.type === 'assistant' && message.message) {
          const content = message.message.content || [];
          const hasToolUse = content.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            // Track tool usage
            for (const part of content) {
              if (part.type === 'tool_use' && (part as any).name) {
                const name = (part as any).name;
                tracker.toolNames.add(name);
                switch (name) {
                  case 'Read': tracker.reads++; break;
                  case 'Edit': case 'MultiEdit': tracker.edits++; break;
                  case 'Write': tracker.writes++; break;
                  case 'Bash': tracker.bashes++; break;
                  default: tracker.others++; break;
                }
              }
            }

            // Update progress status periodically
            const now = Date.now();
            if (statusMessageTs && (now - lastStatusUpdateMs) >= STATUS_UPDATE_INTERVAL_MS) {
              lastStatusUpdateMs = now;
              const progress = formatToolSummary(tracker);
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: `⚙️ *Re-planning...* (${progress})`,
              });
            } else if (lastStatusUpdateMs === 0 && statusMessageTs) {
              lastStatusUpdateMs = now;
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Exploring codebase...*',
              });
            }
          }

          for (const part of content) {
            if ((part as any).type === 'text' && (part as any).text) {
              planningOutput += (part as any).text;
            }
          }
        } else if (message.type === 'result' && message.subtype === 'success' && (message as any).result) {
          const resultText = (message as any).result;
          if (typeof resultText === 'string' && resultText.trim()) {
            if (resultText.includes('## Acceptance Criteria') || resultText.includes('## Questions')) {
              planningOutput = resultText;
            } else if (!planningOutput.trim()) {
              planningOutput = resultText;
            }
          }
        }
      }

      // Check if aborted (e.g. timeout) after the loop completes without throwing
      if (abortController.signal.aborted) {
        throw new Error(timedOut ? 'Re-planning timed out' : 'Re-planning aborted');
      }
    } catch (err) {
      this.logger.error('Re-planning query failed', { itemId, error: err });

      // Move task back to backlog so it can be re-planned
      const replanFailedItem = store.findItem(itemId);
      if (replanFailedItem && replanFailedItem.status === 'planning') {
        store.moveItem(itemId, 'backlog');
      }
      // Release agent claim on failure
      store.updateItem(itemId, { executingAgent: undefined });

      const errMsg = timedOut
        ? `Re-planning for task *#${itemId}* timed out after ${Math.round(config.tasks.planningTimeoutMs / 60000)} minutes. Task moved back to *Backlog*.`
        : `Re-planning for task *#${itemId}* failed: ${(err as Error).message || 'Unknown error'}. Task moved back to *Backlog*.`;

      if (statusMessageTs) {
        await this.app.client.chat.update({ channel, ts: statusMessageTs, text: '❌ *Re-planning failed*' });
      }
      await say({ text: `⚠️ ${errMsg}`, thread_ts: threadTs });
      return;
    } finally {
      clearTimeout(timeoutHandle);
      this.activeControllers.delete(controllerKey);
    }

    // Update status to done
    if (statusMessageTs) {
      const progress = tracker.toolNames.size > 0 ? ` — ${formatToolSummary(tracker)}` : '';
      await this.app.client.chat.update({ channel, ts: statusMessageTs, text: `✅ *Re-planning complete*${progress}` });
    }

    if (!planningOutput.trim()) {
      this.logger.warn('Re-planning returned empty output, moving task to backlog', { itemId });
      store.moveItem(itemId, 'backlog');
      store.updateItem(itemId, { executingAgent: undefined });
      await say({
        text: `⚠️ Re-planning for task *#${itemId}* returned no output. Task moved back to *Backlog*.`,
        thread_ts: threadTs,
      });
      return;
    }

    // Apply planning result (this also saves the spec to .specs/<id>/plan.md)
    const updated = await this.taskPlanner.applyPlanningResult(store, itemId, planningOutput);
    if (!updated) {
      this.logger.error('applyPlanningResult returned null during re-planning, moving task to backlog', { itemId });
      store.moveItem(itemId, 'backlog');
      store.updateItem(itemId, { executingAgent: undefined });
      await say({
        text: `⚠️ Failed to apply re-planning result for task *#${itemId}*. Task moved back to *Backlog*.`,
        thread_ts: threadTs,
      });
      return;
    }

    // Release agent claim after re-planning completes
    store.updateItem(itemId, { executingAgent: undefined });

    if (updated.status === 'clarification_needed' && updated.questions?.length) {
      // Still has questions - need more clarification
      store.updateItem(updated.id, { clarificationThreadTs: threadTs });

      const questionList = updated.questions.map((q, i) => `  ${i + 1}. ${q}`).join('\n');
      await say({
        text: `❓ Task *#${updated.id}* still needs clarification:\n${questionList}\n\nReply in this thread or comment on the Trello card.`,
        thread_ts: threadTs,
      });

      // Also post on Trello card
      if (this.trelloSync && workingDirectory) {
        this.trelloSync.postClarificationComment(workingDirectory, updated.id, updated.questions).catch(err => {
          this.logger.warn('Failed to post Trello clarification comment', { itemId: updated.id, error: err });
        });
      }
    } else {
      // No more questions! Auto-start implementation instead of waiting for manual "go"
      const acCount = updated.acceptanceCriteria?.length ?? 0;
      const specPath = workingDirectory ? `.specs/${updated.id}/plan.md` : '';

      await say({
        text: `✅ Task *#${updated.id}* clarification complete with ${acCount} acceptance criteria.${specPath ? ` Spec saved to \`${specPath}\`.` : ''}\n\n🚀 *Auto-starting implementation...*`,
        thread_ts: threadTs,
      });

      // Move to in_progress and start implementation automatically
      store.moveItem(updated.id, 'in_progress');
      this.triggerTaskImplementation(channel, updated.id, threadTs, say, false).catch(err => {
        this.logger.error('Auto-implementation failed after clarification', { itemId: updated.id, error: err });
        const currentItem = store.findItem(updated.id);
        if (currentItem && currentItem.status === 'in_progress') {
          store.moveItem(updated.id, 'ready');
        }
      });
    }
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      // Get channel info
      const channelInfo = await this.app.client.conversations.info({
        channel: channelId,
      });

      const channelName = (channelInfo.channel as any)?.name || 'this channel';

      // Check if this is an auto-provisioned project channel
      if (this.projectConfig) {
        const mapping = this.projectConfig.getByChannelId(channelId);
        if (mapping) {
          await say({
            text: `👋 Hi! This channel is auto-mapped to \`${mapping.projectPath}\`.\n\nJust start chatting - no \`cwd\` needed!\n\nTasks are synced to Trello automatically.`,
          });
          this.logger.info('Sent provisioned welcome to channel', { channelId, channelName });
          return;
        }
      }

      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;

      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `• \`cwd /path/to/project\` or \`set directory /path/to/project\`\n\n`;
      }

      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads by mentioning me with a different \`cwd\` command.\n\n`;
      welcomeMessage += `Once set, you can ask me to help with code reviews, file analysis, debugging, and more!`;

      await say({
        text: welcomeMessage,
      });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string {
    // Convert markdown code blocks to Slack format
    let formatted = text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return '```' + code + '```';
      })
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');

    return formatted;
  }

  /**
   * Process a self-debug message after crash detection
   * This is called from index.ts when a crash is detected on startup
   */
  async processSelfDebugMessage(
    channel: string,
    threadTs: string,
    debugPrompt: string
  ): Promise<void> {
    this.logger.info('Processing self-debug message', { channel, threadTs });

    // Use a synthetic user ID for self-debugging
    const selfDebugUser = 'self-debug';
    const isDM = channel.startsWith('D');

    // Get working directory (use the project directory for self-debugging)
    const workingDirectory = process.cwd();

    const sessionKey = this.claudeHandler.getSessionKey(selfDebugUser, channel, threadTs);
    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    // Create a new session for self-debugging
    const session = this.claudeHandler.createSession(selfDebugUser, channel, threadTs);

    try {
      let statusMessageTs: string | undefined;

      // Send initial status
      const statusResult = await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: '🔍 *Analyzing crash logs...*',
      });
      statusMessageTs = statusResult.ts as string;

      // Process through Claude
      for await (const message of this.claudeHandler.streamQuery(
        debugPrompt,
        session,
        abortController,
        workingDirectory
      )) {
        if (abortController.signal.aborted) break;

        if (message.type === 'assistant' && message.message) {
          const content = message.message.content || [];
          const hasToolUse = content.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            // Update status
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '🔧 *Investigating fix...*',
              });
            }

            // Format tool usage
            const toolContent = this.formatToolUse(content);
            if (toolContent) {
              await this.app.client.chat.postMessage({
                channel,
                thread_ts: threadTs,
                text: toolContent,
              });
            }
          } else {
            // Handle text response
            const textContent = this.extractTextContent(message);
            if (textContent) {
              const formatted = this.formatMessage(textContent, false);
              await this.app.client.chat.postMessage({
                channel,
                thread_ts: threadTs,
                text: formatted,
              });
            }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            const formatted = this.formatMessage(finalResult, true);
            await this.app.client.chat.postMessage({
              channel,
              thread_ts: threadTs,
              text: formatted,
            });
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: '✅ *Crash analysis completed*',
        });
      }

      this.logger.info('Self-debugging completed successfully');
    } catch (error) {
      this.logger.error('Error during self-debugging', error);

      await this.app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `❌ Error during self-debugging: ${(error as Error).message}`,
      });
    } finally {
      this.activeControllers.delete(sessionKey);
    }
  }

  setupEventHandlers() {
    // Handle direct messages and channel messages
    this.app.message(async ({ message, say }: any) => {
      if (message.subtype !== undefined || !('user' in message)) return;

      const channelId = message.channel;
      const isDM = channelId?.startsWith('D');

      if (isDM) {
        // DMs: always respond
        this.logger.info('Handling direct message event');
        await this.handleMessage(message as MessageEvent, say);
      } else if (this.isProjectChannel(channelId)) {
        // Project channels: respond without @mention
        const botUserId = await this.getBotUserId();
        if (message.user === botUserId) return; // Ignore own messages

        this.logger.info('Handling project channel message', { channel: channelId });
        // Strip any @mention if present
        const text = message.text?.replace(/<@[^>]+>/g, '').trim();
        await this.handleMessage({
          ...message,
          text,
        } as MessageEvent, say);
      }
      // Non-project channels: ignore (handled by app_mention below)
    });

    // Handle app mentions (for non-project channels)
    this.app.event('app_mention', async ({ event, say }: any) => {
      // Skip if this is a project channel (already handled by app.message above)
      if (this.isProjectChannel(event.channel)) return;

      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({
        ...event,
        text,
      } as MessageEvent, say);
    });

    // Handle file uploads in threads
    this.app.event('message', async ({ event, say }: any) => {
      // Only handle file uploads that are not from bots and have files
      if (event.subtype === 'file_share' && 'user' in event && event.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(event as MessageEvent, say);
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }: any) => {
      try {
        // Check if the bot was added to the channel
        const botUserId = await this.getBotUserId();
        if (event.user === botUserId) {
          this.logger.info('Bot added to channel', { channel: event.channel });
          await this.handleChannelJoin(event.channel, say);
        }
      } catch (error) {
        this.logger.error('Error handling member_joined_channel event', error);
      }
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body, respond }: any) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval granted', { approvalId });

      permissionServer.resolveApproval(approvalId, true);

      await respond({
        response_type: 'ephemeral',
        text: '✅ Tool execution approved'
      });
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body, respond }: any) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval denied', { approvalId });

      permissionServer.resolveApproval(approvalId, false);

      await respond({
        response_type: 'ephemeral',
        text: '❌ Tool execution denied'
      });
    });

    // Handle session resume button clicks (resume_session_0 through resume_session_4)
    for (let i = 0; i < 5; i++) {
      this.app.action(`resume_session_${i}`, async ({ ack, body, respond, say }: any) => {
        await ack();

        const value = (body as any).actions[0].value;
        const [sessionId, workingDirectory] = value.split('|');
        const user = body.user.id;
        const channel = body.channel.id;
        const threadTs = body.message?.thread_ts;

        this.logger.info('Session resume button clicked', {
          sessionId,
          workingDirectory,
          user,
          channel,
        });

        try {
          // Get the session info
          const sessionInfo = await this.sessionDiscovery.getSessionById(sessionId, workingDirectory);

          if (!sessionInfo) {
            await respond({
              response_type: 'ephemeral',
              text: `❌ Session \`${sessionId.substring(0, 8)}\` not found.`,
            });
            return;
          }

          // Create or update the session in ClaudeHandler
          let session = this.claudeHandler.getSession(user, channel, threadTs);
          if (!session) {
            session = this.claudeHandler.createSession(user, channel, threadTs);
          }

          // Set the session ID to the one we're resuming
          session.sessionId = sessionInfo.sessionId;
          session.isResumed = true;
          session.resumedFrom = sessionInfo.owner || 'cli';
          session.workingDirectory = workingDirectory;

          // Set ownership to Slack
          this.sessionDiscovery.setSessionOwnership(sessionInfo.sessionId, workingDirectory, {
            channelId: channel,
            threadTs,
            userId: user,
          });

          // Start watching the session
          this.sessionWatcher.watchSession(sessionInfo.sessionId, workingDirectory, {
            channelId: channel,
            threadTs,
            userId: user,
          });

          const shortId = sessionInfo.sessionId.substring(0, 8);
          const timeAgo = this.formatTimeAgo(sessionInfo.lastActivity);

          await respond({
            response_type: 'in_channel',
            text: `📥 *Session resumed:* \`${shortId}...\` (${timeAgo}, ${sessionInfo.messageCount} messages)\n\nYou can now continue the conversation.`,
          });

          this.logger.info('Session resumed via button', {
            sessionId: sessionInfo.sessionId,
            user,
            channel,
          });
        } catch (error) {
          this.logger.error('Error resuming session via button', { error });
          await respond({
            response_type: 'ephemeral',
            text: `❌ Error resuming session: ${(error as Error).message}`,
          });
        }
      });
    }

    // Cleanup inactive sessions periodically
    this.cleanupInterval = setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Shutdown the handler and cleanup resources
   * Call this when the application is shutting down
   */
  shutdown(): void {
    this.logger.info('Shutting down SlackHandler');

    // Stop the session watcher
    this.sessionWatcher.stop();

    // Clear the cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Recover stuck tasks before aborting active controllers
    if (this.taskManager) {
      for (const [sessionKey] of this.activeControllers) {
        try {
          // Parse session key to determine task type and channel
          // Keys are: SYSTEM_IMPL-{channel}-{threadTs} or SYSTEM_PLANNER-{channel}-{threadTs}
          const parts = sessionKey.split('-');
          if (parts.length < 3) continue;
          const prefix = parts[0]; // SYSTEM_IMPL or SYSTEM_PLANNER
          // Channel IDs can contain hyphens, so rejoin all middle parts
          // The threadTs is the last part (e.g. "1234567890.123456")
          const threadTs = parts[parts.length - 1];
          const channel = parts.slice(1, parts.length - 1).join('-');

          if (!channel) continue;

          const store = this.taskManager.getStore(channel);
          const items = store.getItems();

          if (prefix === 'SYSTEM_IMPL') {
            // Move in_progress tasks back to ready
            for (const item of items) {
              if (item.status === 'in_progress') {
                store.moveItem(item.id, 'ready');
                store.updateItem(item.id, { executingAgent: undefined });
                this.logger.info('Shutdown recovery: moved in_progress task to ready', { itemId: item.id, channel });
              }
            }
          } else if (prefix === 'SYSTEM_PLANNER') {
            // Move planning tasks back to backlog
            for (const item of items) {
              if (item.status === 'planning') {
                store.moveItem(item.id, 'backlog');
                store.updateItem(item.id, { executingAgent: undefined });
                this.logger.info('Shutdown recovery: moved planning task to backlog', { itemId: item.id, channel });
              }
            }
          }
        } catch (err) {
          this.logger.error('Error during shutdown task recovery', { sessionKey, error: err });
        }
      }
    }

    // Abort any active requests
    for (const [sessionKey, controller] of this.activeControllers) {
      this.logger.debug('Aborting active request', { sessionKey });
      controller.abort();
    }
    this.activeControllers.clear();

    // Clear maps
    this.todoMessages.clear();
    this.originalMessages.clear();
    this.currentReactions.clear();

    this.logger.info('SlackHandler shutdown complete');
  }
}