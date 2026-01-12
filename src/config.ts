import dotenv from 'dotenv';

dotenv.config();

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    // Channel or user ID to send debug/crash notifications to
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
  // Enable self-debugging after crash
  selfDebugOnCrash: process.env.SELF_DEBUG_ON_CRASH !== 'false', // enabled by default
};

export function validateConfig() {
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