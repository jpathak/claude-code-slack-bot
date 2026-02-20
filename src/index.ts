import pkg from '@slack/bolt';
const { App } = pkg;
import { config, validateConfig } from './config.js';
import { ClaudeHandler } from './claude-handler.js';
import { SlackHandler } from './slack-handler.js';
import { McpManager } from './mcp-manager.js';
import { Logger } from './logger.js';
import { CrashDetector, CrashInfo } from './crash-detector.js';
import { ProjectConfig } from './project-config.js';
import { KanbanManager } from './kanban-manager.js';
import { ChannelProvisioner } from './channel-provisioner.js';
import { WorkingDirectoryManager } from './working-directory-manager.js';
import { BoardApiServer } from './board-api.js';
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

    // Initialize kanban/project components if enabled
    let channelProvisioner: ChannelProvisioner | null = null;
    let projectConfig: ProjectConfig | null = null;
    let boardApiServer: BoardApiServer | null = null;
    let trelloSync: TrelloSync | null = null;

    if (config.kanban.enabled) {
      projectConfig = new ProjectConfig();
      const kanbanManager = new KanbanManager(app, projectConfig);

      // We need a reference to the WorkingDirectoryManager inside SlackHandler.
      // Since SlackHandler creates its own, we create a shared one and pass it
      // via the kanban dependencies. The provisioner uses it to set cwds.
      const sharedWorkingDirManager = new WorkingDirectoryManager();
      channelProvisioner = new ChannelProvisioner(app, projectConfig, sharedWorkingDirManager, kanbanManager);

      // Wire up kanban dependencies into the SlackHandler
      slackHandler.setKanbanDependencies(kanbanManager, projectConfig, channelProvisioner);

      logger.info('Kanban system initialized', {
        autoProvision: config.kanban.autoProvision,
        channelPrefix: config.kanban.channelPrefix,
      });
    }

    // Setup event handlers
    slackHandler.setupEventHandlers();

    // Start the app
    await app.start();

    // Start Board API server if enabled
    if (config.boardApi.enabled && projectConfig) {
      boardApiServer = new BoardApiServer(projectConfig);

      // Wire status transition callbacks: when a task is moved via the web UI,
      // trigger the semi-autonomous workflow (planning / implementation) in Slack.
      boardApiServer.onStatusTransition((projectId, itemId, oldStatus, newStatus, projectPath) => {
        slackHandler.handleExternalStatusTransition(projectId, itemId, newStatus, projectPath, oldStatus).catch(err => {
          logger.error('Error handling external status transition', { projectId, itemId, newStatus, error: err });
        });
      });

      try {
        await boardApiServer.start(config.boardApi.port);
        logger.info('Board API server running', { port: config.boardApi.port });
      } catch (err) {
        logger.error('Failed to start Board API server', err);
        boardApiServer = null;
      }
    } else if (config.boardApi.enabled && !projectConfig) {
      // Board API requires kanban to be enabled (for ProjectConfig)
      logger.warn('Board API enabled but kanban is disabled. Skipping Board API server start.');
    }

    // Record successful startup
    crashDetector.recordStartup();

    logger.info('⚡️ Claude Code Slack bot is running!');
    logger.info('Configuration:', {
      usingBedrock: config.claude.useBedrock,
      usingVertex: config.claude.useVertex,
      usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
      debugMode: config.debug,
      baseDirectory: config.baseDirectory || 'not set',
      kanbanEnabled: config.kanban.enabled,
      autoProvision: config.kanban.autoProvision,
      boardApiEnabled: config.boardApi.enabled,
      boardApiPort: config.boardApi.port,
      trelloEnabled: config.trello.enabled,
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
    });

    // Run channel provisioning sync after Slack connection is established
    if (channelProvisioner && config.kanban.autoProvision) {
      setTimeout(() => {
        channelProvisioner!.syncAll().then((result) => {
          logger.info('Channel provisioning sync completed', result);
        }).catch((err) => {
          logger.error('Channel provisioning sync failed', err);
        });
      }, 3000);
    }

    // Initialize Trello sync if enabled and kanban is active
    if (config.trello.enabled && config.trello.apiKey && config.trello.token && projectConfig) {
      trelloSync = new TrelloSync(config, projectConfig);

      // Wire status transitions: when a card is moved on Trello,
      // trigger the semi-autonomous workflow in Slack.
      trelloSync.onStatusTransition((projectId, itemId, oldStatus, newStatus, projectPath) => {
        slackHandler.handleExternalStatusTransition(projectId, itemId, newStatus, projectPath, oldStatus).catch(err => {
          logger.error('Error handling Trello status transition', { projectId, itemId, newStatus, error: err });
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
      logger.warn('Trello sync enabled but kanban is disabled. Skipping Trello sync.');
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

      // Stop the Board API server
      if (boardApiServer) {
        try {
          await boardApiServer.stop();
        } catch (err) {
          logger.error('Error stopping Board API server during shutdown', err);
        }
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
