# Actor Model Spec (Gent)

BEAM-inspired, Effect-first, local-first with cluster support.

## Scope

- Stable UX: modes/agents fixed; models rotate underneath.
- Actor model for sessions, agents, tools, planning, subagents.
- Local-first execution with a full @effect/cluster adapter.

## Goals

- Deterministic, observable, cancelable runs.
- Uniform mailbox semantics for all tool calls.
- Clear seams for distributed execution.
- Minimal config; curated modes.

## Non-Goals

- Dynamic creation of ad-hoc modes beyond built-ins.
- Provider-specific behavior in core runtime.

## Stable Surface (Modes + Agents)

- Primary: `cowork`, `deep`
- Subagents: `explore`, `architect`
- System: `compaction`, `title`

Model selection is per-mode only. No user-facing model switching.
Pricing metadata is sourced from models.dev (registry).

## Actor Taxonomy

SessionActor (state machine)

- Owns: session+branch lifecycle, current agent, run queue
- Receives: user messages, interrupts, tool results

AgentActor (state machine)

- Executes a single model run
- Emits tool calls + streaming events

ToolActor (state machine)

- Executes all tools via mailbox
- Uniform cancel/timeout/metrics
- Routes tool results back to SessionActor

PlannerActor (state machine)

- Plan tool lifecycle: write -> confirm -> checkpoint/continue

SubagentActor (router)

- Delegates to SubagentRunner (in-proc default)

## Mailbox Semantics

- FIFO per sessionId+branchId
- Interrupt preempts current run
- Interject enqueues next message
- Tool results routed by toolCallId

## ActorProcess RPC (stable boundary)

Requests

- SendUserMessage { sessionId, branchId, content, mode?, bypass? }
- SendToolResult { sessionId, branchId, toolCallId, toolName, output, isError? }
- Interrupt { sessionId, branchId, kind: cancel|interrupt|interject, message? }
- GetState { sessionId, branchId }
- GetMetrics { sessionId, branchId }

Responses

- GetState -> { status, agent?, queueDepth, lastError? }
- GetMetrics -> { turns, tokens, toolCalls, retries, durationMs }

Same protocol for local and cluster.

## Supervision Policy

cowork

- Provider errors: retry with DEFAULT_RETRY_CONFIG
- Tool errors: no retry
- User interrupts: no retry

deep

- Provider errors: extended backoff
- Tool retries only if tool is safe/idempotent

## Tool Lifecycle

1. AgentActor emits tool-call
2. ToolActor executes tool via ToolRunner
3. ToolActor reports tool-result
4. SessionActor decides resume/abort

All tool calls are mailboxed for consistent cancellation and metrics.

## Local Execution (A)

- In-process ActorSystem (effect-machine)
- ToolActor backed by ToolRunner
- Subagents: in-process default, subprocess optional

## Cluster Execution (C)

Entity mapping

- SessionActor is a cluster Entity
- EntityId = `${sessionId}:${branchId}`

Runtime

- SingleRunner for local SQL
- HttpRunner for multi-node
- Storage pluggable: SQLite default, Postgres optional
- SingleRunner expects an @effect/sql SqlClient provided by the host

## Persistence (optional)

- Snapshot + replay hooks for actor state
- Not required for v1

## Failure Modes

- Provider stream failure -> AgentActor fails, SessionActor emits error event
- Tool timeout -> ToolActor reports error, SessionActor applies policy
- Shard move -> SessionActor rehydrates from storage
