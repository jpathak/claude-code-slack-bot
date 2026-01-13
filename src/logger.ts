import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create logs directory if it doesn't exist
const logsDir = path.join(dirname(__dirname), 'logs');

// Check debug mode directly from env vars (avoids config initialization dependency)
const isDebug = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

// Configure the Winston logger
const winstonLogger = winston.createLogger({
  level: isDebug ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
      const ctx = context ? `[${context}]` : '';
      const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
      return `[${timestamp}] [${level.toUpperCase()}] ${ctx} ${message}${metaStr}`;
    })
  ),
  transports: [
    // Console transport
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
          const ctx = context ? `[${context}]` : '';
          const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
          return `[${timestamp}] [${level}] ${ctx} ${message}${metaStr}`;
        })
      )
    }),

    // File transport for all logs
    new DailyRotateFile({
      filename: path.join(logsDir, 'slackbot-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: winston.format.uncolorize()
    }),

    // Separate file for errors
    new DailyRotateFile({
      filename: path.join(logsDir, 'slackbot-error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
      format: winston.format.uncolorize()
    })
  ],
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'exceptions.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'rejections.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private log(level: string, message: string, data?: any) {
    const logData = {
      context: this.context,
      ...(data && { ...data })
    };
    winstonLogger.log(level, message, logData);
  }

  debug(message: string, data?: any) {
    this.log('debug', message, data);
  }

  info(message: string, data?: any) {
    this.log('info', message, data);
  }

  warn(message: string, data?: any) {
    this.log('warn', message, data);
  }

  error(message: string, error?: any) {
    const errorData = error instanceof Error ? {
      errorMessage: error.message,
      stack: error.stack,
      ...error
    } : error;
    this.log('error', message, errorData);
  }
}

// Export a global logger instance for uncaught exceptions
export const globalLogger = new Logger('GLOBAL');

// Log process events
process.on('uncaughtException', (error) => {
  globalLogger.error('Uncaught Exception', error);
  // Give winston time to write logs before exiting
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  globalLogger.error('Unhandled Rejection', { reason, promise });
});

// Log process start
globalLogger.info('Slackbot service starting', {
  nodeVersion: process.version,
  platform: process.platform,
  pid: process.pid
});