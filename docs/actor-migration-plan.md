# Actor Model Migration Plan

## Current Runtime -> Actor Graph Mapping

- AgentLoop -> SessionActor (future rename/wrapper)
- AgentActor -> AgentActor (no change)
- ToolRunner -> ToolActor (mailbox wrapper)
- Plan tool -> PlannerActor
- SubagentRunner -> SubagentActor (router)

Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/agent-actor.ts`, `packages/runtime/src/agent/tool-runner.ts`

## Phase 0 - Interfaces (no behavior change)

- Add ActorProcess service + schemas (local + cluster).
- Keep AgentLoop as current execution engine.
- Provide LocalActorProcess backed by AgentLoop/Storage/EventStore.

Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/tool-runner.ts`

## Phase 1 - ToolActor + PlannerActor

- Move tool execution behind ToolActor mailbox.
- Route plan tool lifecycle through PlannerActor.
- Preserve existing events and storage layout.

Refs: `packages/runtime/src/agent/tool-runner.ts`, `ARCHITECTURE.md`

## Phase 2 - SessionActor formalization

- Rename AgentLoop -> SessionActor (or wrap with new actor shell).
- Move run queue, interrupts, interject into SessionActor.

Refs: `packages/runtime/src/agent/agent-loop.ts`

## Phase 3 - Cluster adapter

- Register SessionActor Entity with @effect/cluster.
- Add ClusterActorProcess service.
- Use SingleRunner for local SQL; HttpRunner for multi-node.
- Pluggable storage: SQLite default, Postgres optional.

Refs: `docs/actor-model.md`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/SingleRunner.ts`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/HttpRunner.ts`

## Phase 4 - Optional persistence

- Add snapshot/replay hooks to SessionActor.
- Enable persistence when cluster storage configured.

Refs: `/Users/cvr/.cache/repo/cevr/effect-machine/src/persistence/persistent-actor.ts`

## Verification Gates

- `bun run typecheck`
- `bun run lint`
- `bun run test`
