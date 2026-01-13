import { spawn, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ClaudeMessage {
  type: string;
  subtype?: string;
  text?: string;
  session_id?: string;
  result?: string;
  uuid?: string;
  message?: {
    id?: string;
    type?: string;
    role?: string;
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: any;
      id?: string;
    }>;
    stop_reason?: string | null;
    stop_sequence?: string | null;
    usage?: any;
  };
  total_cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
  [key: string]: any;
}

export interface StreamQueryOptions {
  outputFormat?: string;
  permissionMode?: string;
  cwd?: string;
  resume?: string;
  allowedTools?: string[];
  mcpServers?: Record<string, any>;
  abortSignal?: AbortSignal;
}

export class ClaudeCLIWrapper {
  private logger = new Logger('ClaudeCLIWrapper');
  private claudePath: string;

  constructor() {
    // Find the CLI path in node_modules
    this.claudePath = join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  }

  async *streamQuery(
    prompt: string,
    options: StreamQueryOptions = {}
  ): AsyncGenerator<ClaudeMessage, void, unknown> {
    const args: string[] = [];

    // Required flags for stream-json to work
    args.push('--output-format', 'stream-json');
    args.push('--print');
    args.push('--verbose'); // Required for stream-json with --print

    // Add permission mode
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }

    // Add resume session
    if (options.resume) {
      args.push('--resume', options.resume);
    }

    // Add allowed tools
    if (options.allowedTools && options.allowedTools.length > 0) {
      args.push('--allowed-tools', options.allowedTools.join(' '));
    }

    // Add MCP servers if provided
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      const mcpConfig = JSON.stringify({ mcpServers: options.mcpServers });
      args.push('--mcp-config', mcpConfig);
    }

    // Pass prompt via stdin with -p flag (reads from stdin)
    args.push('-p', '-');

    this.logger.debug('Starting Claude CLI', {
      claudePath: this.claudePath,
      args: args,
      cwd: options.cwd || process.cwd()
    });

    // Use current Node (should be Node 22 from PATH set in LaunchAgent)
    const nodePath = process.env.CLAUDE_NODE_PATH || process.execPath;

    this.logger.info('Using Node executable', { nodePath, claudePath: this.claudePath });

    const child = spawn(nodePath, [this.claudePath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd || process.cwd(),
      env: process.env
    });

    this.logger.info('Spawned Claude CLI process', { pid: child.pid });

    // Handle abort signal - kill child process when aborted
    const abortHandler = () => {
      this.logger.info('Abort signal received, killing child process', { pid: child.pid });
      child.kill('SIGTERM');
    };

    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    // Write prompt to stdin and close it
    child.stdin!.write(prompt);
    child.stdin!.end();

    // Handle stderr
    child.stderr!.on('data', (data: Buffer) => {
      const stderr = data.toString();
      this.logger.debug('CLI stderr received', { stderr: stderr.substring(0, 500) });
    });

    // Handle process errors
    child.on('error', (error) => {
      this.logger.error('Failed to spawn Claude CLI', error);
    });

    child.on('exit', (code, signal) => {
      this.logger.info('Claude CLI process exited', { code, signal });
      // Clean up abort listener
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
    });

    let outputBuffer = '';
    let messageCount = 0;

    // Convert stream to async iterator
    try {
      for await (const chunk of child.stdout!) {
        // Check if aborted
        if (options.abortSignal?.aborted) {
          this.logger.info('Processing aborted');
          break;
        }

        const chunkStr = chunk.toString();
        this.logger.debug('Received stdout chunk', { length: chunkStr.length });
        outputBuffer += chunkStr;
        const lines = outputBuffer.split('\n');

        // Process all complete lines
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          try {
            const message: ClaudeMessage = JSON.parse(line);
            messageCount++;
            this.logger.debug('Yielding message', { messageCount, type: message.type });
            yield message;
          } catch (e) {
            // Skip non-JSON output (could be verbose logs)
            this.logger.debug('Non-JSON output', { line: line.substring(0, 100) });
          }
        }

        // Keep the incomplete line in buffer
        outputBuffer = lines[lines.length - 1];
      }
    } finally {
      // Ensure cleanup on any exit
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
    }

    this.logger.info('Stdout stream ended', { totalMessages: messageCount });

    // Process any remaining data in buffer
    if (outputBuffer.trim()) {
      try {
        const message: ClaudeMessage = JSON.parse(outputBuffer.trim());
        messageCount++;
        this.logger.debug('Yielding final message', { messageCount, type: message.type });
        yield message;
      } catch (e) {
        this.logger.debug('Final non-JSON output', { line: outputBuffer.substring(0, 100) });
      }
    }

    this.logger.info('streamQuery completed', { totalMessages: messageCount });
  }
}
