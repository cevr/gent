# Handoff — core extension reduction (2026-09-09)

Written by Claude after reading the Codex thread `01a081ae-0b10-7cf1-8ef3-49807dfba419`
(`rm /pr`, 4,357 items, last active 2026-09-09 01:52). This handoff replaces a
re-read of that thread. Work continues in the Rift, not the warm source.

## Where the work lives

| Item               | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| Rift workspace     | `/Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction` |
| Branch             | `refactor/core-extension-reduction`                                  |
| HEAD               | `77505180 fix(core): bind loop construction to the actor scope`      |
| Warm source `main` | `a3c424d5` (14 commits behind the Rift)                              |
| Working tree       | clean                                                                |
| Gate               | green — verified 2026-09-09 by Claude, `/tmp/handoff-gate.log`       |
| `gent` in PATH     | symlink to `<rift>/apps/tui/bin/gent` (a compiled binary)            |

Do not make feature changes in `/Users/cvr/Developer/personal/gent`. That is the
warm source.

## The goal

Plan: [core-extension-reduction-2026-09-08.md](core-extension-reduction-2026-09-08.md).
Receipt: [core-extension-reduction-receipt.md](core-extension-reduction-receipt.md).

Make product behavior an extension over one actor-owned execution loop. Keep
execution ownership in the host. Remove `@gent/core-internal`. The core must run
with no coding tools, no cell kernel, no workflow commands, and no shipped model
choice. The shipped Gent preset adds those through the same extension system that
outside authors use.

The user's maxim: everything must be an extension over the core loop.

## Commits already delivered in this Rift

```
77505180 fix(core): bind loop construction to the actor scope
4cf16681 fix(tui): keep streamed answers with their message owners
89dbd731 fix(tui): preserve whole messages in native scrollback
499a65b9 refactor(tui): consume the supported client protocol
54f2ef02 refactor(core): expose the client protocol contract
1f3fff24 fix(tui): track children through client event streams
f6d135b4 refactor(core): let extensions select model tools
ffba72e7 fix(anthropic): preserve chronological context updates
0b44e887 fix(openai): preserve API-key cache routing
72c9c61a feat(openai): route Codex cache by session
753910d5 fix(openai): preserve chronological context updates
a09715d8 feat(core): retain provider cache usage counters
d3b67214 refactor(tui): reuse head-tail output previews
9854182d refactor(core): use local imports in implementation tests
```

## Next action

**Branch resources under the actor scope.** This is unit 3 of the plan, and the
last commit was its prerequisite.

The actor now allocates one child scope per rebuild and gives it to the behavior.
`agent-loop.behavior.ts:322-331` still builds `CellExecution.Branch` and
`ModelContextLedger.Branch` with a direct `Layer.build`. The kernel is therefore
not an ordinary extension yet.

`domain/resource.ts:38` declares `ResourceScope = "process"` only. Add the branch
lifetime and its host implementation together. Do not add a scope name without
its implementation.

Design constraints recorded from the prior source audit:

- Reuse graph admission and generation leases from `resource-graph-host.ts`.
- The graph host captures `baseContext` once. A branch resource must not retain a
  process-publication service after that publication retires.
- Keep construction dependencies on stable host services and branch resources.
  Supply generation-bound tool authority per call.
- Verify this boundary before wiring resources into turn profiles.

Sources:

- `<rift>/packages/core/src/runtime/agent/agent-loop.behavior.ts:321`
- `<rift>/packages/core/src/domain/resource.ts:38`
- `<rift>/packages/core/src/runtime/extensions/resource-host/resource-graph-host.ts:104`
- `<rift>/packages/core/src/runtime/live-profile.ts`
- `<rift>/packages/core/src/runtime/agent/agent-loop.turn-profile.ts`
- `<rift>/packages/core/src/runtime/code-cell/cell-execution.ts`

## Then, in order

1. **Move kernel evaluation, snapshot policy, and declarations into the
   extension.** Keep generic admission and durable effect receipts in the host.
   Prove reset, interrupt, crash, restart, and branch isolation.
2. **Remove `@gent/core-internal`.** 109 files still reference it: 41 in
   `packages/extensions`, 35 in `apps/tui`, 8 in `packages/e2e`, 7 each in
   `packages/tooling`, `packages/sdk`, and `packages/core`, 3 in `apps/server`,
   plus the package itself. `apps/tui/package.json` and
   `apps/server/package.json` still declare the dependency. Delete the symlink
   package, path aliases, and the obsolete guard rules last.
3. **Durable context admission.** Plan:
   [durable-context-admission-2026-09-08.md](durable-context-admission-2026-09-08.md).
   One host-owned module over `MessageStorage` at
   `packages/core/src/runtime/model-context-admission.ts`. It needs no new Tag,
   table, or actor. Branch resources need not precede it.
4. **Move remaining product policy.** Remove shipped model defaults from the
   loop. Place context and compaction choices in an extension over durable
   history. Retain generic host file locking and edit validation.
5. **Inline one-shot `gent -p`.** Research:
   [inline-prompt-priors-2026-09-08.md](inline-prompt-priors-2026-09-08.md). Use
   OpenTUI `screenMode: "split-footer"`, `externalOutputMode: "capture-stdout"`,
   and `clearOnShutdown: false`. Keep all normal tool calls, cards, approvals,
   and child agents. Stream into native scrollback and exit when the run is
   complete. The research lists 6 required acceptance checks. It ran no live
   experiment.
6. **Reduce internal files and paths.** Collapse single-owner forwarding modules.
   Audit the legacy turn profile path. Do not merge unrelated code to meet a
   file quota.

## Findings from the 2026-09-09 survey

Recorded before starting the branch-resource unit.

- Only three shipped extensions declare a Resource, all `scope: "process"`:
  `packages/extensions/src/btw/index.ts:95`,
  `packages/extensions/src/exec-tools/index.ts:34`, and
  `packages/extensions/src/skills/index.ts:25`. The test layer adds a fourth at
  `packages/core/src/test-utils/e2e-layer.ts:104`. A new scope literal therefore
  touches few real declaration sites.
- `resource-layer.ts:54` and `:97` default a `ResourceScope` parameter to
  `"process"`. Those defaults keep existing callers compiling when the union widens.
- `defineStateResource` pins `scope: "process"` as a literal
  (`domain/resource.ts:182`), not as `ResourceScope`. That is deliberate — state
  resources are process-only — and is not a blocker.
- `schedule-engine.ts:12` states that only process Resources contribute
  schedules. A branch scope must not silently start feeding that reconciler.
- `CellExecution.Branch` already documents "one branch scope owns admission"
  (`runtime/code-cell/cell-execution.ts:66`). The branch concept exists; it is
  simply not expressed through the Resource API yet.
- Two `@gent/core-internal/...` strings are Schema error-tag identifiers, not
  imports: `test-utils/fixtures.ts:51` and `schedule-engine.ts:39`. They carry
  wire identity, so renaming them during the `core-internal` removal is a
  deliberate decision, not a mechanical find-and-replace.
- The artifacts extension is already deleted (`27171e89`, on `main`). The user's
  "artifacts in the kernel" question is closed; do not re-plan it.

## Known open defect

None blocking. The three UI defects found through Herdr are fixed and committed:
wrapped prompt borders (`89dbd731`), missing scrollback rows (`89dbd731`), and
joined streamed answers (`4cf16681`).

## Working rules for this goal

- Each logical code commit passes the full gate **and** a live Herdr check before
  the next unit starts.
- Record deleted lines separately from moved lines. The kernel's 2,645 lines do
  not vanish when they move.
- Do not promise a final LOC target before the caller and lifecycle audit.
- Split a unit that crosses 20 files or several subsystems into compiling
  sub-commits.
- Write the receipt entry after each commit, with evidence paths.

## How to test the TUI with Herdr

This agent runs in Herdr pane `wZ:pG`. The TUI test pane is `wZ:pH`. It is a live
shell at its prompt in `/tmp/gent-model-surface-check`.

Herdr 0.9.0 does not list Gent as a supported agent. `herdr agent prompt` is
rejected. Use the **pane** surface, not the agent surface.

```bash
# Confirm the environment first.
test "${HERDR_ENV:-}" = 1

# Rebuild the binary that PATH points at, after any source change.
cd /Users/cvr/Developer/personal/.rifts/gent/core-extension-reduction
bun run --cwd apps/tui build

# Start a session in the test pane.
herdr pane run wZ:pH 'gent --isolate -p "Use a cell to print 6 * 7. Then reply CHECK-OK."'

# Read what the pane shows.
herdr pane read wZ:pH --source recent --lines 60 --format text

# Cycle disclosure: collapsed -> preview -> full.
herdr pane send-keys wZ:pH ctrl+o

# Cancel an active turn.
herdr pane send-keys wZ:pH ctrl+c

# Check what process holds the pane.
herdr pane process-info --pane wZ:pH
```

Save each read to `/tmp/gent-<unit>-herdr-<state>.txt` and list those paths in
the receipt.

The built-in `@gent/herdr` client extension reports lifecycle state. It activates
only when `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` are all
present. Headless clients do not activate it. See
[herdr-plugin-receipt-2026-09-08.md](herdr-plugin-receipt-2026-09-08.md).

## Live checks that have already passed

Repeat these after a change that touches their area:

- A cell binding survives across two turns in one session.
- Ctrl+C during a 60-second cell produces a cancelled card, and a later cell runs.
- Ctrl+O cycles collapsed, preview, and full, then returns to collapsed.
- A 24-line wrapped prompt keeps its left border on every row across the
  scrollback join.
- Two answers after a context-window boundary stay on separate rows.
- `context.status()` and `context.newWindow()` update the status line and the
  marker card.
- A child agent run shows its tool card and its result.

## Live state at handoff time (2026-09-09, Claude)

The Herdr control loop is verified working. Two prompts submitted to pane `wZ:pH`
and reached a live Gent session. The TUI streamed, and the committed border and
scrollback fixes render correctly.

Both turns failed at the provider: `OpenAiClient.createResponseStream: Rate limit
exceeded`, after 2 of 3 retries. `~/.codex/auth.json` holds tokens and an API
key, so this is an upstream rate limit, not an expired credential. The default
model is GPT-5.6 Luna at maximum reasoning.

Before the first live check of the next unit, submit one throwaway prompt. If it
also reports a rate limit, wait or select another model. Do not read a
rate-limited turn as a product defect.

Re-verified in this session:

- `bun run gate` — passed, `/tmp/handoff-gate.log`.
- `bun run --cwd apps/tui build` — passed, `/tmp/handoff-build.log`. It
  re-symlinked `/Users/cvr/.bun/bin/gent`.
- `herdr pane run` / `read` / `send-keys ctrl+c` against `wZ:pH` — all worked.
