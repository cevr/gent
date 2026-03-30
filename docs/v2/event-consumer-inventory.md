# Event Consumer Inventory

Generated for gent v2 redesign. Grep-backed: every event `_tag` → every file that references it.

## Categories

- **TRANSPORT_CONSUMER**: Referenced in TUI or SDK (user-facing)
- **INTERNAL_ONLY**: Referenced only in core runtime/server
- **DEPRECATED**: Has `@deprecated` comment or is a duplicate
- **TEST_ONLY**: Referenced only in test files (beyond producer)

## Deletion Candidates (safest first)

| Event             | Risk   | Reason                                                                        |
| ----------------- | ------ | ----------------------------------------------------------------------------- |
| SubagentCompleted | None   | Deprecated, zero refs                                                         |
| TodoUpdated       | None   | Zero consumers, zero producers                                                |
| QuestionsAnswered | None   | Zero consumers, zero producers                                                |
| SessionEnded      | None   | Zero refs outside definition                                                  |
| BranchSummarized  | Low    | Produced but never consumed                                                   |
| ToolCallCompleted | Medium | Deprecated but TUI still consumes — needs migration to Succeeded/Failed first |

## Full Inventory

### TRANSPORT_CONSUMER (25)

```
MessageReceived:
  TUI: use-session-feed.ts, agent-lifecycle.ts
  CORE: agent-loop.ts, agent-loop-phases.ts, scenario.ts

StreamStarted:
  TUI: use-session-feed.ts, agent-lifecycle.ts
  CORE: agent-loop.ts, agent-loop-phases.ts, plan.ts, scenario.ts, extension-harness.ts

StreamChunk:
  TUI: use-session-feed.ts, headless-runner.ts
  CORE: plan.ts, scenario.ts

StreamEnded:
  TUI: headless-runner.ts, context.tsx
  CORE: agent-loop.ts, agent-loop-phases.ts, subagent-runner.ts, actor-process.ts, scenario.ts

TurnCompleted:
  TUI: use-session-feed.ts, headless-runner.ts, agent-lifecycle.ts
  CORE: auto.ts, actor-process.ts, agent-loop-phases.ts, plan.ts, scenario.ts, extension-harness.ts

ToolCallStarted:
  TUI: use-session-feed.ts, headless-runner.ts
  CORE: agent-loop.ts, agent-loop-phases.ts, actor-process.ts, scenario.ts, child-session-tracker.ts

ToolCallSucceeded:
  TUI: use-session-feed.ts, headless-runner.ts
  CORE: auto.ts, agent-loop.ts, agent-loop-phases.ts, subagent-runner.ts, actor-process.ts, plan.ts, child-session-tracker.ts, scenario.ts, extension-harness.ts

ToolCallFailed:
  TUI: use-session-feed.ts, headless-runner.ts
  CORE: agent-loop.ts, agent-loop-phases.ts, subagent-runner.ts, actor-process.ts, child-session-tracker.ts, extension-harness.ts

PermissionRequested:
  TUI: use-session-feed.ts, composer-state.ts
  CORE: interaction-handlers.ts

PromptPresented:
  TUI: use-session-feed.ts, composer-state.ts
  CORE: interaction-handlers.ts

HandoffPresented:
  TUI: use-session-feed.ts, headless-runner.ts, composer-state.ts
  CORE: interaction-handlers.ts

HandoffConfirmed:
  TUI: headless-runner.ts
  CORE: interaction-handlers.ts

HandoffRejected:
  TUI: headless-runner.ts
  CORE: interaction-handlers.ts

ErrorOccurred:
  TUI: use-session-feed.ts, headless-runner.ts, context.tsx, agent-lifecycle.ts
  CORE: agent-loop.ts, agent-loop-phases.ts, actor-process.ts

ProviderRetrying:
  TUI: use-session-feed.ts
  CORE: actor-process.ts, agent-loop.ts, agent-loop-phases.ts, scenario.ts

QuestionsAsked:
  TUI: use-session-feed.ts, composer-state.ts
  CORE: ask-user.ts

SessionNameUpdated:
  TUI: context.tsx
  CORE: rename-session.ts

SessionSettingsUpdated:
  TUI: context.tsx
  CORE: session-commands.ts

BranchSwitched:
  TUI: use-session-feed.ts, context.tsx
  CORE: session-commands.ts

AgentSwitched:
  TUI: agent-lifecycle.ts
  CORE: agent-loop.ts, subagent-runner.ts, scenario.ts

TaskCreated:
  TUI: task-widget.tsx
  CORE: plan.ts, task-service.ts

TaskUpdated:
  TUI: task-widget.tsx
  CORE: plan.ts, task-service.ts

TaskCompleted:
  TUI: task-widget.tsx
  CORE: plan.ts, task-service.ts

TaskFailed:
  TUI: task-widget.tsx
  CORE: plan.ts, task-service.ts

TaskDeleted:
  TUI: task-widget.tsx
  CORE: task-service.ts

ExtensionUiSnapshot:
  TUI: context.tsx
  CORE: state-runtime.ts, dependencies.ts
```

### DEPRECATED (2)

```
ToolCallCompleted:
  NOTE: @deprecated — Use ToolCallSucceeded or ToolCallFailed instead
  TUI: use-session-feed.ts, headless-runner.ts (STILL CONSUMED — needs migration)
  CORE: subagent-runner.ts

SubagentCompleted:
  NOTE: @deprecated — zero consumers, zero producers
  Safe to delete immediately.
```

### INTERNAL_ONLY (11)

```
SessionStarted:
  CORE: session-commands.ts (producer only)
  TEST: multiple extension tests

SessionEnded:
  Zero refs outside definition. Dead code.

TurnRecoveryApplied:
  CORE: agent-loop.ts (producer)
  TEST: agent-loop-recovery.test.ts

PromptConfirmed:
  CORE: interaction-handlers.ts (producer, audit trail)

PromptRejected:
  CORE: interaction-handlers.ts (producer, audit trail)

PromptEdited:
  CORE: interaction-handlers.ts (producer, audit trail)

MachineInspected:
  CORE: agent-loop.ts (producer), session-events.ts (filtered OFF transport)

MachineTaskSucceeded:
  CORE: agent-loop.ts (producer), session-events.ts (filtered OFF transport)

MachineTaskFailed:
  CORE: agent-loop.ts (producer), session-events.ts (filtered OFF transport)

BranchSummarized:
  CORE: session-commands.ts (producer, never consumed)

SubagentSpawned:
  CORE: subagent-runner.ts, child-session-tracker.ts

SubagentSucceeded:
  CORE: subagent-runner.ts, child-session-tracker.ts

SubagentFailed:
  CORE: subagent-runner.ts, child-session-tracker.ts

TodoUpdated:
  Zero consumers, zero producers. Dead code.

QuestionsAnswered:
  Zero consumers, zero producers. Dead code.
```

### TEST_ONLY (2)

```
BranchCreated:
  CORE: session-commands.ts (producer)
  TEST: event-stream-parity.test.ts, supervisor.test.ts

AgentRestarted:
  CORE: actor-process.ts (producer)
  TEST: runtime.test.ts
```
