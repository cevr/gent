# Gent Architecture

Minimal, opinionated agent harness.

## Philosophy

- **Minimal**: Small surface area, entire codebase understandable
- **Opinionated**: One way to do things, no configuration bloat
- **Built with Effect**: Services, Layers, Schema, Stream, Ref

## Overview

```
TUI (@opentui/solid) ←── SSE ──→ Server (HttpApi)
                                      │
                              ┌───────▼───────┐
                              │    Runtime    │
                              │  AgentLoop    │
                              │  AgentActor   │
                              │  EventStore   │
                              └───────┬───────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
        ┌─────▼─────┐          ┌─────▼─────┐          ┌─────▼─────┐
        │  Storage  │          │   Tools   │          │ Providers │
        │  SQLite   │          │  Effect   │          │  ai-sdk   │
        └───────────┘          │ Services  │          └───────────┘
                               └───────────┘
```

## Packages

```
packages/
├── core/           # Types, schemas, service interfaces
├── storage/        # SQLite (bun:sqlite) - baked in
├── tools/          # Effect services
├── providers/      # Vercel AI SDK adapters
├── runtime/        # AgentLoop, AgentActor, EventStore, Hooks
├── api/            # HttpApi definitions
└── test-utils/     # Mock layers, sequence recording

apps/
├── tui/            # @opentui/solid
└── server/         # BunHttpServer + SSE
```

## Core Concepts

### Messages

Discriminated union parts:

```typescript
MessagePart = TextPart | ToolCallPart | ToolResultPart | ReasoningPart | ImagePart
Message = { id, sessionId, branchId, role, parts[], createdAt }
```

### Agent Loop + Agents

Primary agent loop is an effect-machine actor (Idle/Running/Interrupted). Subagents run via AgentActor (effect-machine + ActorSystem):

```typescript
AgentLoop {
  run(message)      // Executes; tools can include plan
  steer(command)    // Interrupt mid-run
  followUp(message) // Queue for after completion
}

AgentActor {
  task(run)         // State-scoped task; emits MachineTaskSucceeded/Failed
  inspection        // @machine.* events into EventStore
}
```

**Plan flow (tool-driven):**

1. Agent emits `plan` tool with markdown
2. Plan saved to `.gent/plans/{session}-{toolCall}.md`
3. UI shows markdown inline, user confirms/rejects
4. On confirm, PlanCheckpoint can reset context

**AskUser tool:** Used frequently for clarifying intent, validating assumptions, getting preferences. Not for approval.

### Actor Protocol (Draft)

AgentProcess RPC + mailbox contract (local + cluster):

```
SendUserMessage { sessionId, branchId, content, mode } -> { messageId, turnId }
SendToolResult  { toolCallId, output, isError }      -> { ack: true }
Interrupt       { kind: cancel|interrupt|interject, message? } -> { ack: true }
GetState        {} -> { status, agent, model, queueDepth, lastError? }
GetMetrics      {} -> { tokens, cost, toolCalls, durations, retries }
```

Mailbox semantics:

- FIFO per session/branch
- Tool results must match toolCallId
- Interrupt preempts current run; interject enqueues next message

Cluster mapping: use @effect/cluster Entity + RpcGroup; same RPC surface, sharded by sessionId.

### Supervision Policy (Draft)

Per-mode policy (one-for-one):

- cowork: retry provider errors with DEFAULT_RETRY_CONFIG (maxAttempts=3). No retry on tool errors, permission denies, or user interrupts.
- deep: retry provider errors with extended backoff (maxAttempts=5, maxDelay=60s). Tool retries only if tool is marked safe/idempotent.

See `/Users/cvr/Developer/personal/gent/packages/runtime/src/retry.ts` for current defaults.

### Tools as Effect Services

```typescript
defineTool({
  name: "read",
  params: Schema,
  execute: (params, ctx) => Effect<Result, Error, Deps>,
})
```

Each tool has `Live` + `Test` layers.

**Core tools:** Read, Write, Edit, Bash, Glob, Grep, RepoExplorer, AskUser

### Providers (Model Agnostic)

Vercel AI SDK. Format: `provider/model`

Mid-session switching: `/model openai/gpt-4o`

### Storage

SQLite only. `.gent/data.db`. No configuration.

Tables: Sessions, Branches, Messages, Compactions

### Permissions

Allow-by-default + rules:

```json
{ "tool": "bash", "pattern": "rm -rf *", "action": "deny" }
```

### Events + Hooks

Typed events via EventStore (SQLite log + PubSub). Includes machine inspection
(@machine.\*) + task success/failure for traceability.

### Session Branching

Fork at any message. Tree navigation. Independent compaction per branch.

## Configuration

`.gent/config.json`:

```json
{
  "models": {
    "default": "anthropic/claude-sonnet-4",
    "deep": "anthropic/claude-sonnet-4"
  },
  "permissions": []
}
```

**Baked in (not configurable):**

- SQLite storage
- All core tools enabled
- Compaction at 100k tokens
- Agent switching (cowork/deep)
- Plans in `.gent/plans/`

## Testing

Mock services with sequence recording:

```typescript
const testLayer = createTestLayer({
  providerResponses: [{ text: "Hello!" }],
  files: { "/test.txt": "content" },
})

assertSequence(calls, [
  { service: "provider", method: "stream" },
  { service: "read", method: "execute" },
])
```

## Influences

- **pi-mono**: Lazy LLM adaptation, dual-queue steering, transform pipeline
- **opencode**: Named agent configs, file-based storage, permission rules
- **repo**: Effect service + Layer composition, mock factories, @effect/cli

## Actor Roadmap

Potential future: map subagents to `@effect/cluster` Entity + Sharding for BEAM-like
mailboxes, idle reaping, and defect retry policies. See `packages/cluster/src/Entity.ts`
and `packages/cluster/src/ShardingConfig.ts` in Effect for the knobs we can mirror.
