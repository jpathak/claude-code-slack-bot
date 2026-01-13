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
