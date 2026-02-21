import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
    debugChannel?: string;
  };
  anthropic: {
    apiKey?: string;
  };
  claude: {
    useBedrock: boolean;
    useVertex: boolean;
  };
  baseDirectory: string;
  debug: boolean;
  selfDebugOnCrash: boolean;
  defaultVerbosity: 'minimal' | 'normal' | 'verbose';
  kanban: {
    enabled: boolean;
    autoProvision: boolean;
    channelPrefix: string;
    implementationTimeoutMs: number;
    planningTimeoutMs: number;
  };
  boardApi: {
    port: number;
    enabled: boolean;
    apiKey: string;
    allowedOrigins: string[];
  };
  trello: {
    enabled: boolean;
    apiKey: string;
    token: string;
    pollIntervalMs: number;
  };
}

// Validate required environment variables before creating config
function validateRequiredEnvVars(): void {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Create config object - only called after validation in index.ts
function createConfig(): Config {
  return {
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN || '',
      appToken: process.env.SLACK_APP_TOKEN || '',
      signingSecret: process.env.SLACK_SIGNING_SECRET || '',
      debugChannel: process.env.SLACK_DEBUG_CHANNEL || process.env.SLACK_ADMIN_USER,
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || undefined,
    },
    claude: {
      useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
      useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
    },
    baseDirectory: process.env.BASE_DIRECTORY || '',
    debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
    selfDebugOnCrash: process.env.SELF_DEBUG_ON_CRASH !== 'false',
    defaultVerbosity: (['minimal', 'normal', 'verbose'].includes(process.env.DEFAULT_VERBOSITY || '')
      ? process.env.DEFAULT_VERBOSITY as 'minimal' | 'normal' | 'verbose'
      : 'normal'),
    kanban: {
      enabled: process.env.KANBAN_ENABLED !== 'false',
      autoProvision: process.env.AUTO_PROVISION_CHANNELS !== 'false',
      channelPrefix: process.env.CHANNEL_PREFIX || 'proj-',
      implementationTimeoutMs: parseInt(process.env.TASK_IMPLEMENTATION_TIMEOUT_MS || '1800000', 10), // 30 minutes
      planningTimeoutMs: parseInt(process.env.TASK_PLANNING_TIMEOUT_MS || '600000', 10), // 10 minutes
    },
    boardApi: {
      port: parseInt(process.env.BOARD_API_PORT || '7000', 10),
      enabled: process.env.BOARD_API_ENABLED !== 'false',
      apiKey: process.env.BOARD_API_KEY || '',
      allowedOrigins: process.env.BOARD_API_ALLOWED_ORIGINS
        ? process.env.BOARD_API_ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : ['http://localhost:5173', 'http://localhost:7000'],
    },
    trello: {
      enabled: process.env.TRELLO_ENABLED === 'true',
      apiKey: process.env.TRELLO_API_KEY || '',
      token: process.env.TRELLO_TOKEN || '',
      pollIntervalMs: parseInt(process.env.TRELLO_POLL_INTERVAL_MS || '30000', 10),
    },
  };
}

// Lazy-initialized config singleton
let _config: Config | null = null;

export function validateConfig(): void {
  validateRequiredEnvVars();
  // Initialize config after validation
  _config = createConfig();
}

// Get config - throws if validateConfig() hasn't been called
export const config: Config = new Proxy({} as Config, {
  get(_target, prop: string) {
    if (_config === null) {
      throw new Error('Config accessed before validateConfig() was called');
    }
    return _config[prop as keyof Config];
  },
});
