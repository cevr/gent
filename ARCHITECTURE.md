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
                              │ ActorProcess  │
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
├── core/src/
│   ├── domain/      # Schemas + services: ids, message, event, tool, agent, permission, auth, etc.
│   ├── storage/     # SQLite (bun:sqlite) - baked in
│   ├── providers/   # Vercel AI SDK adapters
│   ├── runtime/     # ActorProcess, AgentLoop, AgentActor, context-estimation, retry
│   ├── tools/       # Read, Write, Edit, Bash, Glob, Grep, etc.
│   ├── server/      # GentCore, RPCs, EventStore, system prompt
│   └── test-utils/  # Mock layers, sequence recording
└── sdk/             # Client wrappers (RPC + HTTP transport)

apps/
├── tui/             # @opentui/solid TUI client
└── server/          # BunHttpServer + SSE
```

No barrel files. `@gent/core` uses subpath exports (`@gent/core/domain/event`, `@gent/core/runtime/agent/agent-loop`, etc.). Internal imports use relative paths.

## Core Concepts

## Actor Model

### Messages

Discriminated union parts:

```typescript
MessagePart = TextPart | ToolCallPart | ToolResultPart | ReasoningPart | ImagePart
Message = { id, sessionId, branchId, role, parts[], createdAt }
```

### ActorProcess + Agent Loop + Agents

GentCore routes all agent work through ActorProcess (single entry point). LocalActorProcessLive delegates to AgentLoop. Defects are surfaced via AgentRestarted events.

```typescript
ActorProcess {
  sendUserMessage(payload)  // Constructs Message, forkDetach agentLoop.run
  sendToolResult(payload)   // Manual tool result injection
  interrupt(payload)        // Cancel/interrupt/interject
  steerAgent(command)       // Switch agent, etc.
}

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
4. On confirm, plan is available to agent as context

**AskUser tool:** Used frequently for clarifying intent, validating assumptions, getting preferences. Not for approval.

### Actor Protocol (Draft)

AgentProcess RPC + mailbox contract (local + cluster):

```
SendUserMessage { sessionId, branchId, content, mode } -> { messageId, turnId }
SendToolResult  { toolCallId, output, isError }      -> { ack: true }
Interrupt       { kind: cancel|interrupt|interject, message? } -> { ack: true }
GetState        {} -> { status, agent, queueDepth, lastError? }
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
- deepwork: retry provider errors with extended backoff (maxAttempts=5, maxDelay=60s). Tool retries only if tool is marked safe/idempotent.

See `packages/core/src/runtime/retry.ts` for current defaults.

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

Model is derived from agent/mode. No user-facing model switching. Pricing metadata comes from models.dev.

### Storage

SQLite only. `.gent/data.db`. No configuration.

Tables: Sessions, Branches, Messages, Todos, Tasks

### Permissions

Allow-by-default + rules:

```json
{ "tool": "bash", "pattern": "rm -rf *", "action": "deny" }
```

### Events + Hooks

Typed events via EventStore (SQLite log + PubSub). Includes machine inspection
(@machine.\*) + task success/failure for traceability.

### Session Branching

Fork at any message. Tree navigation. Handoff for context management.

## Configuration

`.gent/config.json`:

```json
{
  "permissions": []
}
```

**Baked in (not configurable):**

- SQLite storage
- All core tools enabled
- Handoff for context management
- Agent switching (cowork/deepwork)
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
