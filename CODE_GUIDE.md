# Gent Code Guide

A progressive walkthrough to deeply understand the gent codebase. Read files in order—each builds on the last.

---

## Level 1: Core Concepts

Start here. These files define the vocabulary everything else uses.

### 1.1 Data Models

**Read:** `packages/core/src/message.ts`

This is ground zero. Everything flows from these types:

- `Session` — top-level container (has name, cwd, timestamps)
- `Branch` — tree node for forking conversations (parent refs, model override)
- `Message` — the atomic unit: id, role, parts[], timestamps
- `MessagePart` — discriminated union of 5 part types

**Hint:** Notice `Schema.TaggedClass`. This pattern appears everywhere. The `_tag` field enables exhaustive switches and JSON serialization.

**Question to answer:** What's the difference between `ToolCallPart` and `ToolResultPart`? Why are they separate?

### 1.2 Events

**Read:** `packages/core/src/event.ts`

Every state change becomes an event. This is how TUI stays in sync with server.

- `AgentEvent` — union of 18 event types
- `EventStore` — event log + stream (publish, subscribe with replay)

**Hint:** Events carry `sessionId` + `branchId`. The TUI filters: `Stream.filter(e => e.sessionId === mySession)`.

**Question:** Why does `StreamChunk` only have `chunk: string` while `StreamEnded` has `usage`?

### 1.3 Tools

**Read:** `packages/core/src/tool.ts`

Tools are the agent's hands. Understand this interface:

```typescript
ToolDefinition<Name, Params, Result, Error, Deps>
```

- `params` — Schema for validation (must be `AnyNoContext` for sync decode)
- `execute` — Effect that receives decoded params + `ToolContext`
- `ToolContext` — sessionId, branchId, toolCallId

**Hint:** `AnyToolDefinition` exists for variance—tools have different param/result types but need to live in the same array.

---

## Level 2: Storage Layer

How data persists. Single file, no ORM.

### 2.1 SQLite Schema

**Read:** `packages/storage/src/sqlite-storage.ts` (lines 84–157)

Five tables: sessions, branches, messages, checkpoints, todos.

**Hint:** `parts` column stores JSON string. Must decode after parsing:

```typescript
const parts = decodeMessageParts(JSON.parse(row.parts))
```

This is because `JSON.parse` returns plain objects, not Schema.Class instances.

### 2.2 Storage Service

**Read:** `packages/storage/src/sqlite-storage.ts` (full file)

Service pattern: `Storage` is a `Context.Tag`, `Storage.Live(dbPath)` returns a Layer.

**Key operations:**
- `createMessage` / `listMessages`
- `createCheckpoint` / `getLatestCheckpoint`
- `updateMessageTurnDuration`

**Question:** Why does `listMessagesSince(branchId, date)` exist? (Hint: checkpoints)

---

## Level 3: Providers

How we talk to LLMs.

### 3.1 Provider Interface

**Read:** `packages/providers/src/provider.ts`

```typescript
interface ProviderService {
  stream(request) → Stream<StreamChunk>
  generate(request) → Effect<string>  // convenience for non-streaming
}
```

`StreamChunk` types: `TextChunk`, `ToolCallChunk`, `ReasoningChunk`, `FinishChunk`.

**Hint:** Model IDs are `provider/model` format: `"anthropic/claude-sonnet-4"`. The provider parses this to route to correct adapter.

### 3.2 Vercel AI SDK Adapter

**Read:** `packages/providers/src/vercel-adapter.ts`

Converts Vercel AI SDK stream to our `StreamChunk` types. Uses `Stream.async` to bridge callback-based API to Effect streams.

**Question:** Why do we wrap Vercel's SDK instead of using it directly? (Hint: Effect ecosystem, testing)

---

## Level 4: Runtime

The agent's brain.

### 4.1 Agent Loop

**Read:** `packages/runtime/src/agent-loop.ts`

This is the heart. Study it carefully.

**Entry:** `AgentLoop.Live` creates the service. `run(message)` is the public API.

**Core algorithm:** `runLoop` (line ~187) is a recursive generator:

1. Check steer queue (Cancel, Interrupt, Interject, SwitchModel, SwitchMode)
2. Load messages (checkpoint-aware)
3. Build provider request (system prompt + history + tools)
4. Stream from provider, accumulate chunks
5. Process tool calls → execute → collect results
6. Decide: continue or finish
7. Save assistant message, update turn duration

**Steer commands** (line ~60):
- `Cancel` / `Interrupt` — hard stop, emit `StreamEnded(interrupted: true)`
- `Interject` — queue message for immediate processing (no StreamEnded)
- `SwitchModel` — change model mid-run
- `SwitchMode` — toggle plan/build mode

**Hint:** Tool execution happens at line ~125. Permission check → schema decode → run effect → wrap result.

**Question:** What happens if a tool throws? (Hint: `ToolError` part, loop continues)

### 4.2 Checkpoints

**Read:** `packages/runtime/src/checkpoint.ts`

Two types:
- `CompactionCheckpoint` — summarizes old messages, keeps recent
- `PlanCheckpoint` — hard reset, only plan file as context

**Hint:** When loading messages, `getLatestCheckpoint` determines where to start. This enables long conversations without context overflow.

---

## Level 5: Tools Implementation

The agent's capabilities.

### 5.1 Tool Structure

**Read:** `packages/tools/src/read.ts`

Canonical example:
- `ReadParams` — Schema with annotations (for LLM description)
- `ReadResult` — Schema for output
- `ReadError` — Schema.TaggedError for typed failures
- `ReadTool` — `defineTool({ name, description, params, execute })`

**Pattern:** Every tool follows this structure. `execute` is `Effect.fn` for tracing.

### 5.2 AskUser Tool

**Read:** `packages/tools/src/ask-user.ts`

More complex—requires async response from TUI.

- `AskUserHandler` service with `ask`, `askMany`, `respond` methods
- `Live` layer uses `Deferred` map to await TUI response
- Tool calls handler, handler publishes `QuestionsAsked` event, TUI responds via `respondQuestions` RPC

**Hint:** This is the pattern for any tool needing user interaction.

### 5.3 Tool Registry

**Read:** `packages/tools/src/index.ts`

All tools exported, `AllTools` array for registration.

```typescript
ToolRegistry.Live(AllTools)
```

---

## Level 6: Server

Business logic layer.

### 6.1 GentCore Service

**Read:** `packages/server/src/core.ts`

The main service. Methods:
- `createSession` — creates session + branch, optionally sends first message
- `sendMessage` — creates user message, runs agent loop (forked)
- `listMessages` / `listSessions`
- `steer` — forward to agent loop
- `subscribeEvents` — filtered event stream

**Hint:** `sendMessage` forks the agent loop (`Effect.forkDaemon`). It returns immediately; events tell TUI what's happening.

**Hint:** Name generation happens in background (`generateSessionName` with haiku model).

### 6.2 RPC Definitions

**Read:** `packages/server/src/rpcs.ts`

13 RPCs defined with `@effect/rpc`:
- CRUD: createSession, listSessions, getSession, deleteSession
- Messaging: sendMessage, listMessages
- Control: steer, respondQuestions
- Events: subscribeEvents (streaming)

**Hint:** `subscribeEvents` has `stream: true`—it's a server→client stream.

### 6.3 RPC Handlers

**Read:** `packages/server/src/rpc-handlers.ts`

Maps RPC definitions to `GentCore` methods. Most are thin wrappers with `Effect.orDie`.

### 6.4 Dependency Composition

**Read:** `packages/server/src/index.ts`

`createDependencies(config)` builds the full layer stack:

```
Storage → Provider → ToolRegistry → EventStore → Permission
                                            ↓
                            CheckpointService → AskUserHandler
                                            ↓
                                         AgentLoop
```

**Hint:** Layer order matters. AgentLoop needs CheckpointService, which needs Storage + Provider.

---

## Level 7: TUI Application

The user interface.

### 7.1 Entry Point

**Read:** `apps/tui/src/main.tsx`

CLI parsing, state resolution, layer composition, render.

**Key flow:**
1. Parse args: `-H` (headless), `-c` (continue), `-s` (session), `-p` (prompt)
2. `resolveInitialState()` — returns discriminated union (headless/session/home)
3. For headless: `runHeadless()` sends message, streams to stdout
4. For TUI: Create runtime, render `<App />`

**Hint:** RPC uses "test transport" (local in-memory). No HTTP server needed for TUI mode.

### 7.2 Provider Stack

**Read:** `apps/tui/src/main.tsx` (App component, ~line 200)

```tsx
<WorkspaceProvider>     // cwd, gitRoot, gitStatus
  <ClientProvider>      // RPC client, event subscriptions
    <RouterProvider>    // route state
      <Routes />
    </RouterProvider>
  </ClientProvider>
</WorkspaceProvider>
```

### 7.3 Client Context

**Read:** `apps/tui/src/client/context.tsx`

Wraps RPC client with:
- Reactive signals (mode, status, cost, error)
- Event subscription that updates signals
- Convenience methods (sendMessage, steer, etc.)

**Hint:** `subscribeEvents` runs continuously, dispatches to signal updates based on event type.

### 7.4 Session Route

**Read:** `apps/tui/src/routes/session.tsx`

Main view. Contains:
- `messages` signal — built from `MessageInfo[]`
- Event handlers — update messages on `StreamChunk`, `ToolCallStarted`, etc.
- `handleSubmit` — sends message via client
- `inputState` — state machine for input modes

**Hint:** Messages are rebuilt from raw data on `MessageReceived`. Streaming updates append to last message.

### 7.5 Input Component

**Read:** `apps/tui/src/components/input.tsx`

Handles multiple modes:
- Normal — regular text input
- Shell (`!`) — execute bash, show output
- Autocomplete (`$`, `@`, `/`) — popups for skills/files/commands

**Read:** `apps/tui/src/components/input-state.ts`

State machine for input:
- `InputState` — discriminated union (normal, shell, prompt)
- `InputEvent` — what can happen
- `InputEffect` — side effects to execute
- `transition(state, event)` — pure state transition

**Hint:** Session owns `inputState` signal, Input component is mostly presentation.

### 7.6 Message List

**Read:** `apps/tui/src/components/message-list.tsx`

Renders messages with:
- Text content (markdown-ish)
- Tool calls (collapsible, shows status)
- Thinking indicator while streaming

---

## Level 8: Testing

### 8.1 Test Utilities

**Read:** `packages/test-utils/src/index.ts`

Two patterns:
- `createTestLayer()` — simple mocks
- `createRecordingTestLayer()` — mocks + call recording

**Sequence assertion:**
```typescript
const calls = yield* recorder.getCalls()
assertSequence(calls, [
  { service: "Provider", method: "stream" },
  { service: "EventStore", method: "publish", match: { _tag: "StreamStarted" } },
])
```

### 8.2 Example Tests

**Read:** `tests/agent-loop.test.ts`

Shows how to:
- Mock provider responses
- Verify tool execution
- Assert event sequences

---

## Key Patterns Summary

| Pattern | Where | Why |
|---------|-------|-----|
| Discriminated unions | MessagePart, AgentEvent, InputState | Exhaustive matching, no invalid states |
| Schema.TaggedClass | All data types | Type-safe serialization, runtime validation |
| Context.Tag + Layer | All services | Dependency injection, testability |
| Effect.fn | All service methods | Automatic tracing/spans |
| Deferred | AskUserHandler | Async request/response across boundaries |
| Stream + EventStore | Server→TUI | Reactive updates, decoupled components |

---

## Reading Order Checklist

Core concepts:
- [ ] `packages/core/src/message.ts`
- [ ] `packages/core/src/event.ts`
- [ ] `packages/core/src/tool.ts`

Data layer:
- [ ] `packages/storage/src/sqlite-storage.ts`

Provider layer:
- [ ] `packages/providers/src/provider.ts`

Runtime:
- [ ] `packages/runtime/src/agent-loop.ts`
- [ ] `packages/runtime/src/checkpoint.ts`

Tools:
- [ ] `packages/tools/src/read.ts`
- [ ] `packages/tools/src/ask-user.ts`

Server:
- [ ] `packages/server/src/core.ts`
- [ ] `packages/server/src/rpcs.ts`
- [ ] `packages/server/src/index.ts`

TUI:
- [ ] `apps/tui/src/main.tsx`
- [ ] `apps/tui/src/client/context.tsx`
- [ ] `apps/tui/src/routes/session.tsx`
- [ ] `apps/tui/src/components/input-state.ts`

Testing:
- [ ] `packages/test-utils/src/index.ts`

---

## Questions to Test Understanding

1. **Data flow:** Trace a user message from input to storage to response. What events fire?

2. **Tool execution:** What happens when the agent calls `read` on a file that doesn't exist?

3. **Streaming:** Why does TUI rebuild messages on `MessageReceived` but append on `StreamChunk`?

4. **Checkpoints:** How does `PlanCheckpoint` differ from `CompactionCheckpoint`? When is each used?

5. **State machine:** What happens if `QuestionsAsked` event arrives while in shell mode?

6. **Testing:** How would you test that `sendMessage` publishes `StreamStarted` before any `StreamChunk`?

---

## Where to Go Deeper

- **Effect patterns:** `~/.claude/skills/effect` has the effect-solutions CLI
- **OpenTUI/Solid:** `apps/tui/CLAUDE.md` has TUI-specific gotchas
- **Provider details:** `packages/providers/AGENTS.md`
- **Architecture decisions:** `ARCHITECTURE.md` in repo root
