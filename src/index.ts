import pkg from '@slack/bolt';
const { App } = pkg;
import { config, validateConfig } from './config.js';
import { ClaudeHandler } from './claude-handler.js';
import { SlackHandler } from './slack-handler.js';
import { McpManager } from './mcp-manager.js';
import { Logger } from './logger.js';
import { CrashDetector, CrashInfo } from './crash-detector.js';
import { ProjectConfig } from './project-config.js';
import { TaskManager } from './task-manager.js';
import { ChannelProvisioner } from './channel-provisioner.js';
import { WorkingDirectoryManager } from './working-directory-manager.js';
import { BoardStore } from './board-store.js';
import { TrelloSync } from './trello-sync.js';

const logger = new Logger('Main');
const crashDetector = new CrashDetector();

async function handleSelfDebugging(
  app: InstanceType<typeof App>,
  slackHandler: SlackHandler,
  crashInfo: CrashInfo
): Promise<void> {
  const debugChannel = config.slack.debugChannel;

  if (!debugChannel) {
    logger.warn('No debug channel configured for self-debugging. Set SLACK_DEBUG_CHANNEL or SLACK_ADMIN_USER');
    return;
  }

  try {
    // Send initial notification about the crash
    const notifyResult = await app.client.chat.postMessage({
      channel: debugChannel,
      text: `🔴 **Bot Crash Detected**\n\nThe Slack bot crashed and has automatically restarted. Analyzing error logs...`,
    });

    if (!notifyResult.ok || !notifyResult.ts) {
      logger.error('Failed to send crash notification');
      return;
    }

    const threadTs = notifyResult.ts;

    // Generate debug prompt and send it as a follow-up
    const debugPrompt = crashDetector.generateDebugPrompt(crashInfo);

    // Post the debug request in the thread
    await app.client.chat.postMessage({
      channel: debugChannel,
      thread_ts: threadTs,
      text: debugPrompt,
    });

    // Trigger Claude to analyze the crash
    // We simulate receiving this as a message to process
    logger.info('Triggering self-debugging analysis', {
      channel: debugChannel,
      threadTs,
    });

    // Process the debug message through the normal flow
    // The SlackHandler will handle this and send it to Claude
    await slackHandler.processSelfDebugMessage(debugChannel, threadTs, debugPrompt);

    // Mark the crash as analyzed
    crashDetector.markCrashAnalyzed(crashInfo);
    crashDetector.clearErrorLog();

    logger.info('Self-debugging initiated successfully');
  } catch (error) {
    logger.error('Failed to initiate self-debugging', error);
  }
}

/**
 * Scan all projects for tasks stuck in transient states (in_progress, planning)
 * and move them to recovery states. This handles orphaned tasks from bot crashes.
 */
async function recoverStuckTasks(
  app: InstanceType<typeof App>,
  projectConfig: ProjectConfig,
  logger: Logger,
): Promise<void> {
  const projects = projectConfig.getAll();
  let recoveredCount = 0;

  for (const project of projects) {
    try {
      const store = new BoardStore(project.projectPath);
      const items = store.getItems();
      const recovered: string[] = [];

      for (const item of items) {
        // Skip tasks owned by Claude Code CLI - it manages its own state
        if (item.executingAgent === 'claude-code') continue;

        if (item.status === 'in_progress') {
          store.moveItem(item.id, 'ready');
          store.updateItem(item.id, { executingAgent: undefined });
          recovered.push(`#${item.id} (in_progress -> ready)`);
          recoveredCount++;
        } else if (item.status === 'planning') {
          store.moveItem(item.id, 'backlog');
          store.updateItem(item.id, { executingAgent: undefined });
          recovered.push(`#${item.id} (planning -> backlog)`);
          recoveredCount++;
        }
      }

      store.dispose();

      if (recovered.length > 0) {
        logger.info('Startup recovery: moved stuck tasks', {
          project: project.projectName,
          recovered,
        });

        // Notify the project's Slack channel
        try {
          await app.client.chat.postMessage({
            channel: project.channelId,
            text: `🔄 *Startup recovery:* ${recovered.length} stuck task(s) recovered after restart:\n${recovered.map(r => `  - ${r}`).join('\n')}`,
          });
        } catch (slackErr) {
          logger.warn('Failed to send recovery notification to Slack', {
            channel: project.channelId,
            error: slackErr,
          });
        }
      }
    } catch (err) {
      logger.error('Error during startup recovery for project', {
        project: project.projectName,
        error: err,
      });
    }
  }

  if (recoveredCount > 0) {
    logger.info('Startup recovery complete', { totalRecovered: recoveredCount });
  } else {
    logger.info('Startup recovery complete: no stuck tasks found');
  }
}

async function start() {
  try {
    // Validate configuration
    validateConfig();

    // Check for crash from previous session
    const crashInfo = crashDetector.detectCrash();
    if (crashInfo) {
      logger.warn('Detected crash from previous session', {
        timestamp: crashInfo.timestamp,
        errorLogLength: crashInfo.errorLog.length,
      });
    }

    logger.info('Starting Claude Code Slack bot', {
      debug: config.debug,
      useBedrock: config.claude.useBedrock,
      useVertex: config.claude.useVertex,
      selfDebugOnCrash: config.selfDebugOnCrash,
    });

    // Initialize Slack app
    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    // Initialize MCP manager
    const mcpManager = new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();

    // Initialize handlers
    const claudeHandler = new ClaudeHandler(mcpManager);
    const slackHandler = new SlackHandler(app, claudeHandler, mcpManager);

    // Initialize task management/project components if enabled
    let channelProvisioner: ChannelProvisioner | null = null;
    let projectConfig: ProjectConfig | null = null;
    let taskManager: TaskManager | null = null;
    let trelloSync: TrelloSync | null = null;

    if (config.tasks.enabled) {
      projectConfig = new ProjectConfig();
      taskManager = new TaskManager(app, projectConfig);

      // We need a reference to the WorkingDirectoryManager inside SlackHandler.
      // Since SlackHandler creates its own, we create a shared one and pass it
      // via the task dependencies. The provisioner uses it to set cwds.
      const sharedWorkingDirManager = new WorkingDirectoryManager();
      channelProvisioner = new ChannelProvisioner(app, projectConfig, sharedWorkingDirManager, taskManager);

      // Wire up task dependencies into the SlackHandler
      slackHandler.setTaskDependencies(taskManager, projectConfig, channelProvisioner);

      logger.info('Task management initialized', {
        autoProvision: config.tasks.autoProvision,
        channelPrefix: config.tasks.channelPrefix,
      });
    }

    // Setup event handlers
    slackHandler.setupEventHandlers();

    // Start the app
    await app.start();

    // Record successful startup
    crashDetector.recordStartup();

    logger.info('⚡️ Claude Code Slack bot is running!');
    logger.info('Configuration:', {
      usingBedrock: config.claude.useBedrock,
      usingVertex: config.claude.useVertex,
      usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
      debugMode: config.debug,
      baseDirectory: config.baseDirectory || 'not set',
      tasksEnabled: config.tasks.enabled,
      autoProvision: config.tasks.autoProvision,
      trelloEnabled: config.trello.enabled,
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
    });

    // Run channel provisioning sync after Slack connection is established
    if (channelProvisioner && config.tasks.autoProvision) {
      setTimeout(() => {
        channelProvisioner!.syncAll().then((result) => {
          logger.info('Channel provisioning sync completed', result);
        }).catch((err) => {
          logger.error('Channel provisioning sync failed', err);
        });
      }, 3000);
    }

    // Recover tasks stuck in transient states from a previous crash/restart
    if (projectConfig && taskManager) {
      const recoveryProjectConfig = projectConfig;
      setTimeout(() => {
        recoverStuckTasks(app, recoveryProjectConfig, logger);
      }, 4000);
    }

    // Initialize Trello sync if enabled and task management is active
    if (config.trello.enabled && config.trello.apiKey && config.trello.token && projectConfig) {
      trelloSync = new TrelloSync(config, projectConfig);

      // Give SlackHandler a reference to TrelloSync for posting clarification comments
      slackHandler.setTrelloSync(trelloSync);

      // Wire status transitions: when a card is moved on Trello,
      // trigger the semi-autonomous workflow in Slack.
      trelloSync.onStatusTransition((projectId, itemId, oldStatus, newStatus, projectPath) => {
        slackHandler.handleExternalStatusTransition(projectId, itemId, newStatus, projectPath, oldStatus).catch(err => {
          logger.error('Error handling Trello status transition', { projectId, itemId, newStatus, error: err });
        });
      });

      // Wire clarification replies: when a user replies to a clarification comment
      // on a Trello card, re-trigger planning with the answer.
      trelloSync.onClarificationReply((projectId, itemId, replyText, projectPath) => {
        slackHandler.handleTrelloClarificationReply(projectId, itemId, replyText, projectPath).catch(err => {
          logger.error('Error handling Trello clarification reply', { projectId, itemId, error: err });
        });
      });

      // Delay Trello initialization to allow Slack connection to fully establish
      setTimeout(async () => {
        try {
          const projects = projectConfig!.getAll();
          for (const project of projects) {
            await trelloSync!.initializeProject(project.channelId, project.projectPath, project.projectName);
          }
          trelloSync!.startPolling();
          logger.info('Trello sync started', { projectCount: projects.length });
        } catch (err) {
          logger.error('Failed to initialize Trello sync', err);
        }
      }, 5000);
    } else if (config.trello.enabled && !projectConfig) {
      logger.warn('Trello sync enabled but task management is disabled. Skipping Trello sync.');
    } else if (config.trello.enabled && (!config.trello.apiKey || !config.trello.token)) {
      logger.warn('Trello sync enabled but TRELLO_API_KEY or TRELLO_TOKEN not set. Skipping.');
    }

    // Initiate self-debugging if there was a crash and it's enabled
    if (crashInfo && config.selfDebugOnCrash) {
      // Delay slightly to ensure Slack connection is fully established
      setTimeout(() => {
        handleSelfDebugging(app, slackHandler, crashInfo).catch((err) => {
          logger.error('Self-debugging failed', err);
        });
      }, 2000);
    }

    // Setup graceful shutdown handlers
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      // Stop the Trello sync
      if (trelloSync) {
        trelloSync.dispose();
      }

      // Shutdown the Slack handler (stops watchers, clears intervals, aborts requests)
      slackHandler.shutdown();

      // Stop the Slack app
      await app.stop();

      logger.info('Shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();
