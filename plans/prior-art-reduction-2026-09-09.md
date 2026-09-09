# Prior art — what four harnesses do that gent does not

Date: 2026-09-09. Surveyed: opencode (v2 work, on `dev` at `337fd144d` —
**there is no `v2` branch**; the services are tagged `@opencode/v2/*` and
`src/v1/` is a 1,341-line legacy shim), prime-agent, exo, deepseek-harness.

## Size, for scale

| Harness         |                 Core LOC |     Loop LOC |     Tools |    Concepts | Storage LOC |           Extension machinery |
| --------------- | -----------------------: | -----------: | --------: | ----------: | ----------: | ----------------------------: |
| **exo**         |  15,661 (8,420 reusable) |      **~86** |       ~21 |     **~10** |     **181** | **~1 line** + 49 for profiles |
| **opencode v2** |                   32,966 |    14 + ~150 |        12 | 35 services |       2,620 |                        ~4,561 |
| **prime-agent** |                  117,674 | not isolable |     **1** |         ~65 |       2,324 |                        ~4,106 |
| **deepseek**    |                  274,879 |   ~130 + 290 | unbounded |    ~50 pkgs |       2,460 |                       ~21,868 |
| **gent (now)**  | 45,497 core / 81,323 all |            — |        17 |           — |       4,479 |                             — |

Gent's core sits between opencode and prime-agent. Its storage layer (4,479)
is the largest of any harness here except deepseek's multi-backend one, and
**24× exo's**.

## The five findings that matter

### 1. The loop is not the problem

exo's whole loop is 86 lines
(`exoharness/typescript/model-runtime/turn-loop.ts:101-187`): `for(;;)` →
build tools → build messages → call model → `if (toolCalls.length === 0)
return` → serial `for` over calls → append events. That is a complete,
correct agent loop.

Gent's `runtime/agent` is **10,487 lines across 34 files**. The delta is not
the loop; it is durability, actors, queueing, interruption, and replay. Some
of that gent needs and exo does not (exo has no resumable sessions). But 34
files for one loop is the fragmentation the goal names.

**prime-agent is the anti-example**: its loop is diffused through an
**11,288-line** `agent-session.ts` with `while(true)` at five sites. Fewer
files is not automatically better — one god-file is worse than 34 modules.

### 2. Rebuild, don't invalidate — the cheapest trick in the survey

exo re-creates the entire tool registry **every model round**
(`turn-loop.ts:121-126`). That single decision deletes the whole class of
registry-lifecycle and cache-invalidation code, _and_ is what makes
model-authored tools live within the same turn.

Gent instead has: `runtime/extensions` 4,922 lines, of which
`resource-host` is **2,864** — generations, leases, publications, drain vs
cancel, plan reconciliation. Plus `live-profile.ts` (799) and
`session-profile.ts` (572) compiling profiles.

This is the single largest reduction candidate in gent. **But it is not free**:
gent's resource host exists to keep long-lived state (a cell kernel, a file
index, a scheduler) alive _across_ turns. exo can rebuild per round precisely
because it has no such state. The question to answer is not "can we rebuild
per round" but **"which resources actually need to outlive a turn?"** —
everything else can be rebuilt and its lifecycle machinery deleted.

### 3. Extensibility does not require a registry

exo: `defineHarness` is **one line** (`harness/index.ts:390`). Profiles are
**49 lines across 3 files**. Third-party harnesses extend by _importing and
calling_ `registerExoTools`, then appending their own. No lifecycle, no
manifest, no activation, no compilation step.

Compare 4,561 (opencode) / 4,106 (prime) / 21,868 (deepseek) for the same
capability. Gent is nearer the high end.

Rule 3 says everything is an extension of the loop. exo shows that maxim is
compatible with _almost no machinery_ — extension by composition rather than
registration.

### 4. Fewer tools does not buy fewer concepts

prime-agent went to **exactly one tool** — `ipython`
(`core/tools/index.ts:44-46`, `allToolNames = new Set(["ipython"])`) — and
still carries ~65 core modules, session leases, a boot gate, a fork server,
an orphan-process journal, and the 11k-line class.

Gent has already banked the one-tool win (`cell-extension.ts:36-44`). This
finding is the warning attached to it: **do not expect the tool collapse to
reduce concept count on its own.** They are independent axes.

### 5. Code execution is the consensus, with three variants

Three of four have gone to code execution:

- **prime-agent**: one tool, persistent IPython kernel, state lives in the
  interpreter, results are stdout + image blocks (`tools/ipython.ts:626-679`).
- **deepseek**: `run_code` _alongside_ native calling, selectable per agent
  via `presentAs`; TS or Python in a worker thread (`tools/src/ptc.ts`).
- **opencode**: a whole `packages/codemode/` (6,878 LOC) — but **not wired
  in**; `builtins.ts:26-29` still lists "Rune/code mode" as a TODO.
- **exo**: no code tool — instead the model **authors durable tools**
  (`install_agent_tool`), which the per-round registry rebuild makes live
  immediately.

Gent's cell is closest to prime-agent's, with one advantage: it is a **Bun**
kernel, so host tools and cell code share one runtime and one language.

## What this says for gent

Ranked by lines removed per unit of risk:

1. **Audit which resources need to outlive a turn.** The resource host
   (2,864) + profile compilation (1,371) is ~4,200 lines serving a small
   number of genuinely long-lived resources. Anything rebuildable per turn
   should be, following exo.
2. **Collapse the duplicated provider credential machinery** (~2,900 lines
   across anthropic + openai, structurally parallel) into one generic
   service. Pure duplication, low risk.
3. **Trim host tools that a Bun cell does better.** `glob` is done. Each
   removal takes a tool file, a TUI renderer, a test, and a catalog line.
4. **Consolidate `runtime/agent`'s 34 files** — but as _modules_, never
   toward prime-agent's god-file. Target the 4 submit variants
   (`Submit`, `SubmitAndWait`, `SubmitDurable`, `Run`) and the 7
   `agent-runner.*` files.
5. **Do not delete `core-internal`.** It is a symlink; removing it is 230
   import rewrites that weaken the public/internal boundary.

## Corrections to earlier assumptions

- "opencode v2 branch" does not exist. The v2 work is on `dev`.
- opencode's codemode is built but **unwired** — it is not evidence that
  codemode is production-proven there.
- exo's 15,661 includes a Rust host; the reusable TS harness is **8,420**.
