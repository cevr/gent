# Actor Model Spec + Cluster Adapter Plan (Local-first, cluster-now)

## Decisions (locked)

- [x] Actor-model spec (BEAM-like semantics)
- [x] Modes fixed; models rotate
- [x] Plan is a tool; cowork/deep only; read-only gating
- [x] Subagent isolation: in-process default; subprocess optional
- [x] Persistence hooks optional in spec
- [x] Cluster adapter now; HttpRunner
- [x] Cluster storage pluggable: SQLite default, Postgres optional
- [x] Shard key: sessionId + branchId
- [x] ToolActor scope: all tools

## Findings (with refs)

- Runtime already uses effect-machine actors for loop + subagent execution. Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/agent-actor.ts`
- Agent registry already encodes fixed modes + subagents + preferred models. Refs: `packages/core/src/agent.ts`
- Tool execution centralized in ToolRunner (good insertion point). Refs: `packages/runtime/src/agent/tool-runner.ts`
- Subagent runner exists with in-process default + subprocess stub. Refs: `packages/runtime/src/agent/subagent-runner.ts`
- Current architecture doc already sketches Actor Protocol + mailbox semantics. Refs: `ARCHITECTURE.md`
- effect-machine provides ActorSystem/ActorRef + persistence hooks. Refs: `/Users/cvr/.cache/repo/cevr/effect-machine/src/actor.ts`, `/Users/cvr/.cache/repo/cevr/effect-machine/src/persistence/persistent-actor.ts`
- @effect/cluster provides Entity + ShardingConfig + SingleRunner + HttpRunner. Refs: `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/Entity.ts`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/ShardingConfig.ts`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/SingleRunner.ts`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/HttpRunner.ts`
- OpenCode fixed agent modes pattern (build/plan) supports stable UX. Refs: `/Users/cvr/.cache/repo/anomalyco/opencode/README.md`
- pi-mono subagent process isolation + plan-mode step tracking useful patterns. Refs: `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/subagent/README.md`, `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/plan-mode/README.md`

## Plan (progressive disclosure, executable)

### Phase 0 — Spec frame + invariants

- [x] Write **spec outline** (overview → protocol → actor types → supervision → failure modes → local vs cluster). Refs: `ARCHITECTURE.md`
- [x] Define **stable surface**: cowork/deep + fixed agent catalog; model swap only. Refs: `packages/core/src/agent.ts`, `/Users/cvr/.cache/repo/anomalyco/opencode/README.md`
- [x] Define **actor taxonomy**: SessionActor, AgentActor, ToolActor, PlannerActor, SubagentActor; which are state machines vs routers. Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/agent-actor.ts`, `/Users/cvr/.cache/repo/cevr/effect-machine/src/actor.ts`
- [x] Define **mailbox semantics**: FIFO per session+branch, interrupt preempts current run, tool results routed by toolCallId. Refs: `ARCHITECTURE.md`
- [x] Define **supervision policy** per mode (cowork/deep). Refs: `ARCHITECTURE.md`, `packages/runtime/src/retry.ts`

### Phase 1 — Local actor graph (A)

- [x] Map **current runtime → actor graph**; minimal refactors (AgentLoop → SessionActor, AgentActor retains). Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/agent-actor.ts`
- [x] Define **LocalActorProcess**: in-process ActorSystem + session mailbox. Refs: `/Users/cvr/.cache/repo/cevr/effect-machine/src/actor.ts`
- [x] Define **ToolActor**: all tools mailboxed; uniform cancel/timeout/metrics; integrates ToolRunner. Refs: `packages/runtime/src/agent/tool-runner.ts`, `packages/tools/src/index.ts`
- [x] Define **PlannerActor**: plan tool lifecycle + confirmation state + checkpoint hooks. Refs: `ARCHITECTURE.md`, `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/plan-mode/README.md`
- [x] Define **SubagentActor** routing to SubagentRunner; in-process default. Refs: `packages/runtime/src/agent/subagent-runner.ts`, `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/subagent/README.md`

### Phase 2 — Cluster adapter (C)

- [x] Specify **ActorProcess RPC** (stable boundary for local + cluster). Refs: `ARCHITECTURE.md`
- [x] Build **Entity mapping**: SessionActor entity sharded by sessionId+branchId; sub-actors as internal messages. Refs: `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/Entity.ts`
- [x] Implement **cluster layer**: SingleRunner (SQLite default), HttpRunner for multi-node; ShardingConfig from env; pluggable storage (SQLite/Postgres). Refs: `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/SingleRunner.ts`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/HttpRunner.ts`, `/Users/cvr/.cache/repo/Effect-TS/effect/packages/cluster/src/ShardingConfig.ts`
- [x] Add **ClusterActorProcess** service; LocalActorProcess remains default. Refs: `ARCHITECTURE.md`
- [x] Define **persistence hooks** (snapshot/replay optional). Refs: `/Users/cvr/.cache/repo/cevr/effect-machine/src/persistence/persistent-actor.ts`

### Phase 3 — Deliverables

- [x] Write **Actor Model Spec** doc (new file) + link from `ARCHITECTURE.md`. Refs: `ARCHITECTURE.md`
- [x] Write **Migration Plan** (staged refactors + rollout + tests). Refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/agent-actor.ts`, `packages/runtime/src/agent/subagent-runner.ts`
- [x] Write **Mode Catalog** (cowork/deep + subagents + tool policies). Refs: `packages/core/src/agent.ts`

### Phase 4 — Verification

- [x] Review plan coverage vs decisions; adjust if gaps
- [x] Run `bun run typecheck`, `bun run lint`, `bun run test` after code changes
