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
2. ~~Collapse the duplicated provider credential machinery.~~ **Withdrawn
   after reading both.** See "Provider credentials are not duplication" below.
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

## Audit: which resources actually need to outlive a turn?

Finding 2 said the question is not "can we rebuild per round" but "what
genuinely needs to persist". Answered by inventory.

**Every non-test `scope: "process"` resource in the repo — there are three:**

| Resource                           | Site                                    | Holds                                                                                                                                  | Outlives a turn?                              |
| ---------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `@gent/skills/service`             | `extensions/src/skills/index.ts:22`     | Skills read from disk at layer setup; `list` is `Effect.succeed(skills)` (`skills.ts:181`) with **no reload path** (`skills.ts:22-23`) | **No.** Immutable cache of a disk read.       |
| `@gent/exec-tools/background-bash` | `extensions/src/exec-tools/index.ts:32` | Background process handles; `start` runs `storage.reconcileInterrupted`                                                                | **Yes.** Owns live OS processes across turns. |
| `@gent/btw/runs`                   | `extensions/src/btw/index.ts:93`        | In-flight side-question runs, forked with `Effect.forkIn(effect, scope)` (`:88`)                                                       | **Yes.** Owns running fibers.                 |

Everything else matching `scope: "process"` is a test fixture
(`test/e2e-layer/process-override`) or a doc sample (`my-ext/service` in
`extensions/api.ts:21`). **Zero schedules are registered anywhere.**

So the resource host — 2,864 lines of generations, leases, publications,
retire modes, and plan reconciliation — plus ~1,371 lines of profile
compilation, exists to keep **two** things alive: background bash processes
and btw run fibers. Skills is a cache that could be rebuilt per turn without
anyone noticing.

That is the reduction target, and it is much better-shaped than expected: two
genuinely long-lived resources do not need a generational graph with drain
semantics. They need a process-lifetime scope and a start hook.

**Not yet a proposal.** Deleting the host is a large, high-blast-radius
change; the resource graph is also what the `resource-graph-rpc` surface and
its storage (`resource-graph-storage.ts`, 679 lines) report on. The next step
is to establish what observable behavior would be lost, not to start cutting.

## Provider credentials are not duplication — withdrawing that candidate

The reduction survey flagged anthropic + openai credential code (~2,900
lines) as parallel duplication, on the evidence that both expose
`CredentialCacheCell`, `CredentialServiceApi`, `CredentialIO`, and
`CredentialService`. Reading the bodies, that was wrong.

The **API shapes** rhyme. The **implementations solve different problems**:

- **Anthropic** reads credentials Claude Code already owns: it spawns
  `security` against the macOS keychain (`anthropic/oauth/keychain.ts:19`,
  `:61`), with a credentials-file fallback (`credentials-file.ts`) and a CLI
  fallback (`keychain.ts:95`). There is no authorization flow — gent is a
  reader of someone else's credentials.
- **OpenAI** runs a full OAuth flow it owns: authorization and device
  variants, a local callback, token exchange and refresh
  (`openai/oauth.ts:472`, `:543`, `:713`, `:742`, `:765`).

The cache state machines differ too. Anthropic's is
cache-hit / read / refresh / persist. OpenAI's adds `durableCell` vs
`pendingPersistCell`, an `invalidated` flag, and retry of a pending persist
(`openai/credential-service.ts:71`, `:82`, `:255`, `:320`, `:351`) — a
**superset**, because its write-back can fail independently of its refresh.

Extracting a shared service would force Anthropic's simpler path through
OpenAI's larger state machine, adding a coupling that must then be understood
by anyone touching either. That trades ~200 lines of similar-looking
scaffolding for a worse abstraction. The remaining bulk — keychain spawning,
OAuth flows, request transforms — is irreducibly provider-specific.

**Correction recorded rather than quietly dropped**: the earlier claim came
from comparing exported symbol names, not implementations. Symbol-shape
similarity is not duplication.

## Candidates tested and rejected

Three apparent collapses were checked against the code. Two did not survive;
recording them so they are not re-proposed.

**`Submit` / `SubmitDurable` — rejected.** The two actor handlers have
byte-identical bodies (`agent-loop.handlers.ts:836-846`, both
`submitTurn(operation).pipe(provideActorWorkspace)`), which looks like pure
duplication. It is not: the protocol entry for `SubmitDurable` carries
`persisted: true` (`agent-loop.protocol.ts:285`), so the actor framework
writes the operation to durable storage for restart recovery. The handler is
the same because the _behavior_ is the same; the delivery guarantee differs.
`session-runtime.ts:502-506` picks between them on `completion === "admission"`.
The duplication is in the declaration, and that is where it belongs.

**Ephemeral vs durable agent runners — rejected.** `agent-runner.durable.ts`
(492) and `agent-runner.ephemeral.ts` (397) look like two implementations of
one thing. Both are live: `agent-runner.ts:201` branches on
`persistence === "ephemeral"`, and two shipped extensions request it —
`btw/index.ts:161` and `session-tools/read-session.ts:144` — to run a child
without creating durable session rows. Removing either removes a capability.

**Provider credentials — rejected**, see the section above.

**What survived: the resource host.** Of the four large candidates, only the
resource-host audit held up, and it held up strongly: 2,864 + ~1,371 lines
serving two genuinely long-lived resources.

### Method note

Two of three rejections came from comparing _names and shapes_ rather than
reading implementations. Symbol-level similarity is a hypothesis, not
evidence. For the remaining candidates, read the bodies and find a live call
site before proposing removal.
