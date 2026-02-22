# Claude Code Slack Bot

A TypeScript Slack bot that provides AI-powered coding assistance via Claude Code, with semi-autonomous task management synced bidirectionally to Trello.

## System Architecture

### Three-Interface Model

The system has three interaction surfaces:

1. **Claude Code (CLI)** - Primary coding interface. Reads/writes `.tasks/board.json` (a local sync file) which auto-syncs to Trello. No Slack notifications for CLI-driven changes.
2. **Trello** - The task board. Each project has its own Trello board. When tasks are moved on Trello (e.g., to `in_progress`), the Slack bot picks them up and triggers workflows (planning, implementation).
3. **Slack** - Conversational AI interface + monitoring for Trello-initiated task transitions. No task management commands in Slack.

**Key principle:** Trello is the board. `.tasks/board.json` is a sync intermediary that bridges Claude Code to Trello. Changes in either direction are reconciled automatically.

### Core Message Flow

```
User sends message in Slack
  -> slack-handler.ts receives event (app_mention or message.im)
  -> Resolves working directory (thread > channel > DM > base)
  -> Looks up or creates ConversationSession in ClaudeHandler
  -> claude-handler.ts spawns Claude CLI via claude-cli-wrapper.ts
  -> CLI runs with --output-format stream-json --permission-mode bypassPermissions
  -> Async generator yields ClaudeMessage objects back to slack-handler
  -> slack-handler formats and posts/updates Slack messages in real time
  -> Status reactions track progress (thinking_face -> gear -> white_check_mark)
```

### Task Lifecycle

```
backlog -> planning (Claude analyzes, generates AC)
  -> ready (no questions) OR clarification_needed (has questions)
  -> in_progress (Claude implements)
  -> review (Claude marks complete)
  -> done (user approves) OR back to in_progress (retry)
```

Each status maps to a Trello list. Trello-initiated status changes trigger the Slack bot to run planning or implementation workflows automatically. Claude Code CLI changes (identified by `executingAgent: "claude-code"`) sync to Trello silently with no Slack notifications.

## Project Structure

```
src/
  index.ts                      Entry point, initialization, startup recovery
  config.ts                     Environment configuration and validation
  types.ts                      TypeScript type definitions (TaskItem, BoardData, etc.)

  # Slack Integration
  slack-handler.ts              Main Slack event handling, message routing, tool formatting
  verbosity-manager.ts          Per-channel/thread verbosity levels (minimal/normal/verbose)
  working-directory-manager.ts  Hierarchical cwd resolution (thread > channel > DM > base)

  # Claude Code Integration
  claude-handler.ts             Session management, MCP server loading, query orchestration
  claude-cli-wrapper.ts         Spawns Claude CLI process, streams JSON output
  permission-mcp-server.ts      MCP server for permission prompts (currently disabled)

  # Session Management
  session-discovery.ts          Discover CLI/Slack sessions from ~/.claude/projects/
  session-watcher.ts            Poll for CLI takeover of Slack sessions (handoff detection)

  # Task Management & Trello Sync
  task-manager.ts             Store management, item CRUD, Slack Lists API integration
  board-store.ts                File-backed local sync state (.tasks/board.json)
  task-planner.ts               Planning/implementation prompt generation, spec I/O
  project-config.ts             Channel-to-project mapping registry (project-config.json)
  channel-provisioner.ts        Auto-discover projects, provision Slack channels
  trello-sync.ts                Bidirectional Trello sync (outbound debounced 2s, inbound polled 30s)

  # Infrastructure
  crash-detector.ts             Detect crashes, enable self-debugging via Claude
  file-handler.ts               Download and process Slack file uploads
  todo-manager.ts               Real-time task list tracking in Slack threads
  mcp-manager.ts                Load MCP server configs from mcp-servers.json
  logger.ts                     Winston structured logging with daily rotation
```

## Module Details

### slack-handler.ts

The central routing module. Handles all Slack events and dispatches to appropriate subsystems.

**Inbound command routing** (checked in order):
1. `cwd <path>` / `cwd` - Working directory set/get
2. `mcp` / `mcp reload` - MCP server info/reload
3. `verbosity <level>` / `verbosity` - Verbosity set/get
4. Thread reply to clarification task - Route to clarification handler
5. `continue [session-id]` / `sessions` - Session management
6. Everything else - Send to Claude Code

**Key methods:**
- `handleMessage()` - Main entry point for all messages
- `handleExternalStatusTransition()` - Trello-initiated task transitions (suppresses notifications when `executingAgent === 'claude-code'`)
- `triggerTaskPlanning()` - Run Claude for AC generation
- `triggerTaskImplementation()` - Run Claude for task implementation
- `handleClarificationReply()` - Process answers to task questions

**Verbosity modes:**
- `minimal` - Only final result + tool summary
- `normal` - Task lists + status updates + final result
- `verbose` - Individual tool use messages + everything

### claude-handler.ts / claude-cli-wrapper.ts

**claude-handler.ts** manages sessions and orchestrates queries:
- Session key: `userId-channelId-threadTs`
- Loads MCP servers from McpManager, converts to `--mcp-config` temp file
- Permission mode: `bypassPermissions` (permission MCP server disabled)
- Cleans up sessions inactive >30 minutes

**claude-cli-wrapper.ts** spawns the actual CLI process:
- Locates CLI at `node_modules/@anthropic-ai/claude-code/cli.js`
- Flags: `--output-format stream-json --print --verbose --permission-mode bypassPermissions`
- Writes prompt to stdin, reads newline-delimited JSON from stdout
- Handles abort via SIGTERM on AbortSignal
- Parses `ClaudeMessage` objects: system (init with session_id), assistant (text/tool_use), result (success/error)

### board-store.ts

File-backed local sync state at `{projectPath}/.tasks/board.json`. This file is the bridge between Claude Code and Trello - not a standalone board.

- **Atomic writes:** Write to `.board.json.tmp.{timestamp}` then `rename()`
- **Change detection:** MD5 hash tracking to detect external modifications
- **File watching:** `fs.watch` on `.tasks/` directory with 100ms debounce
- **Change callbacks:** Notifies TrelloSync of mutations via `onChanged()`
- **CRUD:** `addItem()`, `updateItem()`, `deleteItem()`, `moveItem()`, `findItem()` (by ID, `#ID`, or partial title match)

### trello-sync.ts

Bidirectional sync between local board.json and the project's Trello board.

**Outbound (local -> Trello):**
- Triggered by BoardStore `onChanged()` callback, debounced 2 seconds
- Creates new Trello cards for unmapped items
- Updates cards if content hash differs
- Deletes cards for deleted items
- Echo prevention: tracks recent outbound syncs (10s window)

**Inbound (Trello -> local):**
- Polls Trello every 30s (configurable via `TRELLO_POLL_INTERVAL_MS`)
- Detects status changes and fires `statusTransitionCallback`
- Creates local items for Trello-only cards
- Recovery: reads "Local ID: #N" from card description to re-map after restart

**Mapping persistence:** `.tasks/trello-mapping.json` stores Trello board ID, list IDs (one per status column), and card-level mappings (localId <-> trelloCardId with sync hashes).

### task-planner.ts

Generates context-rich prompts for Claude and parses structured output.

**Prompt generation:**
- `generatePlanningPrompt()` - Includes task description, board context, instruction to output AC/questions
- `generateImplementationPrompt()` - Includes AC, spec from `.specs/{id}/plan.md`, board context
- `generateRetryImplementationPrompt()` - Adds review feedback context

**Output parsing:**
- Extracts `## Acceptance Criteria`, `## Questions`, `## Subtasks` sections
- Updates board item with parsed AC/questions
- Moves item to `ready` or `clarification_needed` based on whether questions exist

**Spec storage:**
- `.specs/{taskId}/plan.md` - Planning output
- `.specs/{taskId}/implementation.md` - Implementation notes

### session-discovery.ts / session-watcher.ts

**session-discovery.ts** catalogs Claude sessions:
- Sessions stored at `~/.claude/projects/{encoded_cwd}/{sessionId}.jsonl`
- Ownership tracking: `.session-owners.json` per project directory
- Parses session metadata (message count, summary, last activity)

**session-watcher.ts** detects CLI takeover:
- Polls watched sessions every 30s
- Compares file mtime to last known modification
- Fires `onHandoff()` callback when CLI modifies a Slack-owned session
- SlackHandler notifies user of handoff

### channel-provisioner.ts

Auto-discovers projects and creates/adopts Slack channels.

- Scans `BASE_DIRECTORY` for non-hidden subdirectories
- Creates channels with prefix (default `proj-`)
- Sets topic, posts welcome message, creates Slack List if available
- Saves mapping to ProjectConfig

### project-config.ts

Persistent registry mapping channels to projects. Stored in `project-config.json`.

```typescript
ProjectMapping {
  channelId, channelName, projectPath, projectName,
  listId (Slack Lists API), createdAt, lastSyncedAt
}
```

Used by: TaskManager, TrelloSync, ChannelProvisioner, SlackHandler (for cwd fallback).

### crash-detector.ts

Detects crashes from previous run and triggers self-debugging.

- Compares error log modification time against last startup timestamp
- Generates debug prompt with last 5KB of error log
- Sends to Claude for analysis via normal message flow
- Storage: `.crash-data/last-startup.txt`, `.crash-data/crash-state.json`

### Startup Sequence (index.ts)

1. Validate config (env vars)
2. Check for crash from previous session
3. Initialize Slack app (Socket Mode)
4. Initialize MCP manager
5. Create ClaudeHandler + SlackHandler
6. If task management enabled: create ProjectConfig, TaskManager, ChannelProvisioner
7. Wire task management dependencies into SlackHandler
8. Setup Slack event handlers
9. Start Slack app
10. Record successful startup
11. After 3s: Run channel provisioning sync
12. After 4s: Recover stuck tasks (in_progress -> ready, planning -> backlog)
13. After 5s: Initialize Trello sync (create boards/lists, start polling)
14. If crash detected: trigger self-debugging after 2s
15. Register SIGTERM/SIGINT shutdown handlers

## Environment Configuration

### Required
```env
SLACK_BOT_TOKEN=xoxb-...        # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...        # App-Level Token (connections:write scope)
SLACK_SIGNING_SECRET=...        # From Basic Information
```

### Optional
```env
# Working Directory
BASE_DIRECTORY=/Users/.../Code/  # Base for relative cwd paths

# Claude Provider (default: Anthropic API)
ANTHROPIC_API_KEY=...
CLAUDE_CODE_USE_BEDROCK=1        # Use AWS Bedrock
CLAUDE_CODE_USE_VERTEX=1         # Use Google Vertex AI

# Task Management
TASKS_ENABLED=true               # Default: true (set to 'false' to disable)
AUTO_PROVISION_CHANNELS=true     # Default: true
CHANNEL_PREFIX=proj-             # Default: 'proj-'
TASK_IMPLEMENTATION_TIMEOUT_MS=1800000  # 30 min default
TASK_PLANNING_TIMEOUT_MS=600000         # 10 min default

# Trello Sync
TRELLO_ENABLED=true
TRELLO_API_KEY=...
TRELLO_TOKEN=...
TRELLO_POLL_INTERVAL_MS=30000    # Default: 30s

# Self-Debugging
SELF_DEBUG_ON_CRASH=true         # Default: true (set to 'false' to disable)
SLACK_DEBUG_CHANNEL=...          # Channel or user ID for crash reports

# Verbosity
DEFAULT_VERBOSITY=normal         # minimal | normal | verbose

# Debug
DEBUG=true                       # Enable debug logging
```

## Slack App Configuration

### Required Permissions (Bot Token Scopes)
- `app_mentions:read`, `channels:history`, `channels:manage`, `channels:read`
- `chat:write`, `chat:write.public`
- `im:history`, `im:read`, `im:write`
- `users:read`, `reactions:read`, `reactions:write`

### Required Events
- `app_mention` - Bot mentioned in channel
- `message.im` - Direct messages
- `member_joined_channel` - Bot added to channel

### Socket Mode
Required. App-level token with `connections:write` scope.

## Deployment (macOS launchd)

The bot runs as a macOS launchd service.

- **Service label:** `com.jpathak.claude-code-slack`
- **Plist:** `~/Library/LaunchAgents/com.jpathak.claude-code-slack.plist`
- **Runs:** `npm run dev` (tsx watch) from project directory
- **Logs:** `~/Library/Logs/claude-code-slack.log` (stdout), `~/Library/Logs/claude-code-slack.error.log` (stderr)
- **KeepAlive:** `true` (auto-restarts on crash)

### Service Commands
```bash
launchctl kickstart -k gui/$(id -u)/com.jpathak.claude-code-slack  # Restart
launchctl bootout gui/$(id -u)/com.jpathak.claude-code-slack       # Stop
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jpathak.claude-code-slack.plist  # Start
launchctl list com.jpathak.claude-code-slack                       # Status
tail -f ~/Library/Logs/claude-code-slack.log                       # Logs
```

## Development

### Build and Run
```bash
npm install
npm run build    # TypeScript compilation
npm run dev      # Development with hot reload (tsx watch)
npm run prod     # Production mode (node dist/index.js)
npm test         # Run vitest suite
npm run test:watch
```

### Test Files
```
src/board-store.test.ts          BoardStore CRUD, file watching, atomic writes
src/task-manager.test.ts       Item CRUD, listing, todo sync
src/project-config.test.ts       ProjectConfig persistence, queries
src/channel-provisioner.test.ts  Channel creation, adoption, sync
src/session-discovery.test.ts    Session listing, ownership, metadata
src/verbosity-manager.test.ts    Verbosity level management
src/task-planner.test.ts         Prompt generation, output parsing
src/task-recovery.test.ts        Startup recovery for stuck tasks
src/trello-sync.test.ts          Bidirectional sync, echo prevention
```

### Key Design Decisions

1. **CLI Wrapper over SDK** - Claude Code SDK has compatibility issues; the bot spawns CLI as a child process with `--output-format stream-json`
2. **File-Backed Sync** - `.tasks/board.json` is a local sync intermediary readable by both CLI and bot, bridging to Trello
3. **Atomic Writes** - Board writes use tmp+rename to prevent corruption
4. **Echo Prevention** - Trello sync tracks recent outbound timestamps (10s window) to avoid responding to its own changes
5. **Agent Coordination** - `executingAgent` field on items prevents CLI and Slack bot from working on the same task simultaneously
6. **Notification Suppression** - `handleExternalStatusTransition()` returns early when `executingAgent === 'claude-code'`, ensuring CLI changes sync to Trello silently
7. **Spec Persistence** - Planning and implementation specs saved to `.specs/{taskId}/` for audit trail and context across sessions
8. **Hierarchical Working Directories** - Thread override > Channel default > DM default > BASE_DIRECTORY fallback
9. **Debounced Sync** - Outbound Trello sync debounced 2s, fs.watch debounced 100ms, inbound poll every 30s
10. **Session Ownership** - Tracked in `.session-owners.json` per project to enable CLI<->Slack handoff detection

## Data Files

| File | Location | Purpose |
|------|----------|---------|
| `board.json` | `{project}/.tasks/` | Local sync state (bridges Claude Code to Trello) |
| `trello-mapping.json` | `{project}/.tasks/` | Trello card <-> local item mappings |
| `plan.md` | `{project}/.specs/{taskId}/` | Planning output (AC, analysis) |
| `implementation.md` | `{project}/.specs/{taskId}/` | Implementation notes |
| `project-config.json` | Bot root | Channel-to-project registry |
| `mcp-servers.json` | Bot root | MCP server configuration |
| `.session-owners.json` | `~/.claude/projects/{cwd}/` | Session ownership tracking |
| `{sessionId}.jsonl` | `~/.claude/projects/{cwd}/` | Claude session transcripts |
