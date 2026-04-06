# RLM Integration Plan

## Context

RLM (Recursive Language Models — Zhang, Kraska, Khattab, MIT CSAIL 2026) is a divide-and-conquer pattern for processing inputs that exceed context windows. The core insight: treat files as symbols (metadata only in context, never raw content), delegate semantic work to sub-agents, recurse bounded by max depth.

The reference implementation (`claude-rlm`) uses bash scripts, tmux sessions, and sentinel files. We don't need any of that — gent already has `DelegateTool` (parallel + chain modes), `SubagentRunnerService`, `AgentActor`, and `BashTool`. The RLM value is the **programming model in the prompt**, not the scaffolding.

## Approach: Prompt-first + depth tracking

Add an `"rlm"` agent whose `systemPromptAddendum` teaches the file-symbol mental model and decomposition strategies. The agent uses existing tools (`bash`, `delegate`, `read`, `write`, `glob`, `grep`) — no new tools needed. The one structural addition: depth propagation through the sub-agent pipeline so recursion is bounded.

## Changes

### 1. Add `"rlm"` agent definition

**File:** `packages/core/src/agent.ts`

- Add `"rlm"` to `AgentName` literal union
- Add `RLM_PROMPT` constant with the programming model instructions (file-symbol protocol, decomposition strategy, workspace convention, depth awareness)
- Add `rlm` to `Agents` object: `allowedTools: ["read", "write", "bash", "glob", "grep", "delegate"]` (any agent with `delegate` can target any registered agent, including self for recursion)
- Add `rlm` to `AgentModels` with a sensible default (sonnet), but this is overridable — see step 2

### 2. Add depth + model fields to `SubagentRunner` interface

**File:** `packages/core/src/agent.ts`

Add to `SubagentRunner.run` params:

- `rlmDepth?: number` — current recursion depth
- `rlmMaxDepth?: number` — max recursion depth
- `rlmModel?: string` — model override for RLM sub-agents

The model is **model-agnostic**: the caller picks it. The `DelegateTool` params will accept an optional `model` field, and the RLM system prompt will teach the agent it can specify a model when delegating. The `AgentModels["rlm"]` entry serves as a fallback default only.

### 3. Extend `ToolContext` with depth + model

**File:** `packages/core/src/tool.ts`

Add to `ToolContext`:

- `rlmDepth?: number`
- `rlmMaxDepth?: number`
- `rlmModel?: string`

This lets the delegate tool read the current depth/model from context (injected by AgentActor) rather than requiring the agent to manually track it.

### 4. Add RLM defaults

**File:** `packages/core/src/defaults.ts`

```
rlmMaxDepth: 3
```

### 5. Extend `AgentRunInput` with depth/model + propagate in AgentActor

**File:** `packages/runtime/src/agent/agent-loop.ts`

- Add to `AgentRunInputFields`: `rlmDepth`, `rlmMaxDepth`, `rlmModel` (all `Schema.UndefinedOr(...)`)
- In `AgentActor.runEffect`: when building `ToolContext` for tool calls (line ~1139), include `rlmDepth`, `rlmMaxDepth`, `rlmModel` from `input`
- If `input.rlmModel` is set, use it instead of `resolveAgentModelId(agent.name)` for the provider call
- In `AgentActor.runEffect`: when building the system prompt for an rlm agent, append a depth status line:
  ```
  ## RLM Depth
  Current depth: {N}/{max}. Remaining: {max - N}.
  ```
  At max depth: `"MAX DEPTH REACHED. Process directly, do not delegate further."`

### 6. Pass depth + model through `InProcessRunner`

**File:** `packages/runtime/src/agent/subagent-runner.ts`

In `InProcessRunner`, pass `rlmDepth`, `rlmMaxDepth`, and `rlmModel` from `params` through to `actor.run(...)`.

### 7. Auto-increment depth in DelegateTool + model passthrough

**File:** `packages/core/src/tools/delegate.ts`

- Add optional `model` field to `TaskParams` and `TaskItem` schemas — allows the agent to specify which model sub-agents should use
- When calling `runner.run` for an agent named `"rlm"`:
  - Read current depth from `ctx.rlmDepth` (set by AgentActor for rlm sub-agents)
  - Auto-increment: `rlmDepth: (ctx.rlmDepth ?? 0) + 1`
  - Pass `rlmMaxDepth: ctx.rlmMaxDepth ?? DEFAULTS.rlmMaxDepth`
  - Pass `rlmModel: params.model ?? ctx.rlmModel` (explicit param wins, then inherit from parent)
- When a non-rlm agent delegates to rlm for the first time (ctx.rlmDepth is undefined), seed at depth 0

## What doesn't change

- Provider interface — sub-agents already use it
- Storage / SQLite schema — sub-agents already create sessions/branches
- `ToolRegistry` — rlm uses existing tools
- EventStore — SubagentSpawned/Succeeded/Failed already capture lifecycle
- `buildSystemPrompt` in `system-prompt.ts` — RLM instructions live in `systemPromptAddendum`

## Recursion flow

```
Cowork: "Analyze this 50k-line codebase"
  └─ delegate(agent: "rlm", task: "Analyze /path")
      └─ RLM depth=0/3
          ├─ bash: wc -l, head — inspects metadata
          ├─ bash: mkdir -p .rlm/analyze/{chunks,results}
          ├─ bash: split into chunks/
          └─ delegate(tasks: [
              {agent: "rlm", prompt: "Analyze chunk-01"},
              {agent: "rlm", prompt: "Analyze chunk-02"},
            ])
            ├─ RLM depth=1/3: reads chunk, writes result
            └─ RLM depth=1/3: reads chunk, writes result
          └─ bash: cat results/* → final synthesis
```

## Guardrails

- **Depth bound**: `DEFAULTS.rlmMaxDepth = 3`. Hard stop in system prompt + could add enforcement in delegate tool.
- **Concurrency bound**: existing `MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4` in delegate.ts.
- **Cost**: Model is caller's choice. Default fallback in `AgentModels` is sonnet. The agent or user can override per-invocation via the `model` field on delegate params.

## Verification

1. `bun run typecheck` — ensure AgentName union, new fields, etc. compile clean
2. `bun run lint` — no-any, no floating promises
3. `bun run test` — existing tests pass (new fields are optional, backwards compatible)
4. Manual smoke test: `bun run --cwd apps/tui dev -H "Use the rlm agent to analyze the packages/ directory"` — verify it spawns sub-agents, creates workspace, produces aggregated output
5. Verify depth enforcement: check that at max depth the agent processes directly instead of delegating
