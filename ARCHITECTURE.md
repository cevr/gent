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
                              │  EventBus     │
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
├── runtime/        # AgentLoop, EventBus, Hooks
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

### Agent Loop + Magic Plan Mode

Single loop. Agent decides when to plan:

```typescript
AgentLoop {
  run(message)      // Agent decides: plan vs execute
  steer(command)    // Interrupt mid-run
  followUp(message) // Queue for after completion
}
```

**Plan flow:**
1. Agent analyzes task complexity OR user asks for plan
2. If planning needed → read-only tools, uses AskUser to clarify
3. Writes plan to `.gent/plans/{timestamp}-{slug}.md`
4. User approves via UI
5. Context clears → plan loads → execution begins

**AskUser tool:** Used frequently for clarifying intent, validating assumptions, getting preferences. Not for approval.

### Tools as Effect Services

```typescript
defineTool({
  name: "read",
  params: Schema,
  execute: (params, ctx) => Effect<Result, Error, Deps>
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

15+ typed events via PubSub. Full lifecycle hooks.

### Session Branching

Fork at any message. Tree navigation. Independent compaction per branch.

## Configuration

`.gent/config.json`:

```json
{
  "models": {
    "default": "anthropic/claude-sonnet-4",
    "plan": "anthropic/claude-sonnet-4"
  },
  "permissions": []
}
```

**Baked in (not configurable):**
- SQLite storage
- All core tools enabled
- Compaction at 100k tokens
- Magic plan mode
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
