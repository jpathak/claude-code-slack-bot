import pkg from '@slack/bolt';
const { App } = pkg;
import { config, validateConfig } from './config.js';
import { ClaudeHandler } from './claude-handler.js';
import { SlackHandler } from './slack-handler.js';
import { McpManager } from './mcp-manager.js';
import { Logger } from './logger.js';
import { CrashDetector, CrashInfo } from './crash-detector.js';

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
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
    });

    // Initiate self-debugging if there was a crash and it's enabled
    if (crashInfo && config.selfDebugOnCrash) {
      // Delay slightly to ensure Slack connection is fully established
      setTimeout(() => {
        handleSelfDebugging(app, slackHandler, crashInfo);
      }, 2000);
    }
  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();