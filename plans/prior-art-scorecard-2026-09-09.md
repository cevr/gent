# Prior-art recommendations: what landed, what did not

Date: 2026-09-09
Status: scorecard closing the reduction goal.

The four prior arts (opencode v2 on `dev`, prime-agent, exo, deepseek-harness)
were surveyed in an earlier session; findings are in
`plans/prior-art-reduction-2026-09-09.md`. None of the four repos are checked
out on this machine, so this scorecard works from that recorded survey rather
than re-reading them.

The survey ranked five candidates. Here is what happened to each.

## 1. "Audit which resources need to outlive a turn" (exo's rebuild-don't-invalidate)

**Ranked #1. Outcome: closed, no reduction available.**

The survey's inventory found three process-scoped resources and argued skills
was "a cache that could be rebuilt per turn without anyone noticing".

Acted on it: skills moved from `process` to `branch` scope (`6b824b1c`), so it
now rebuilds once per agent-loop branch instead of living for the server's
lifetime. That is the survey's recommendation, implemented.

Going further — removing its resource declaration entirely — **does not work**.
`resource` is the only registration domain through which an extension can
contribute a service layer (`RegistrationDomainMap`, `extension-host.ts:29-37`).
Deleting the declaration would require inventing a second layer-contribution
mechanism: adding a concept to remove a concept.

The remaining question the survey left open — do two long-lived resources
justify 2,864 lines of host? — was tested concept by concept
(`plans/resource-host-verdict-2026-09-09.md`). Generations gate durable
tool-binding resume; leases implement the drain/cancel primitive; retire modes
were empirically proven distinct (disabling `"cancel"` fails a test with a 5s
timeout). All three are load-bearing.

What is left is a _redesign_ — could two resources use a simpler mechanism? —
not a deletion. Its blast radius is the `resourceGraph` RPC surface plus
`resource-graph-storage.ts` (679 lines). That is a decision to take
deliberately, not a cut to make while tidying.

## 2. "Collapse provider credential machinery"

**Withdrawn in the survey itself**, after reading both implementations.
Anthropic reads Claude Code's macOS keychain; OpenAI runs its own OAuth flows.
Symbol-shape similarity, not duplication.

## 3. "Trim host tools a Bun cell does better"

**Partially landed, then closed.**

`glob` removed (`5c639a4a`) — a directory walk is just Bun, and the tool added
no semantics.

Tested the next candidate, `write`, and **rejected it**: it takes
`ctx.FileLock.withLock` (mutual exclusion between concurrent agents — the cell
has no `FileLock` access), resolves workspace-relative through `ctx.Files`, and
supports atomic write-then-rename. Same for `edit`. Replacing them with
`Bun.write` drops mutual exclusion — a correctness loss.

This is the user's own rule cutting both ways: "certain tools are better for
certain tasks than raw JS or Bun … but certain things can actually just be
better expressed using bun — like glob."

## 4. "Consolidate runtime/agent's 34 files — target the 4 submit variants"

**Tested, mostly rejected; one real removal found nearby.**

The survey named `Submit` / `SubmitAndWait` / `SubmitDurable` / `Run`. The
survey itself had already rejected `Submit`/`SubmitDurable`: identical handler
bodies, but `persisted: true` on the protocol entry means a different delivery
guarantee.

Auditing all fifteen actor operations for production call sites found three
with zero — `RecordToolResult`, `InvokeTool` (`1062aca6`), and `Interrupt`
(`911b998d`). −685 lines. The other twelve, including all four submit
variants, are live.

## 5. "Do not delete core-internal"

**Heeded.** It is a symlink; removing it is 230 import rewrites that weaken the
public/internal boundary. Untouched.

## Findings the survey made that this session confirms

- **"Fewer tools does not buy fewer concepts"** (finding 4) — confirmed exactly.
  Gent has banked the one-tool win: the model has **1 callable tool**, verified
  live (`plans/kernel-codemode-verdict-2026-09-09.md`). Concept count did not
  fall as a result; the reductions that landed came from unrelated axes.

- **prime-agent as anti-example** (finding 1) — its 11,288-line
  `agent-session.ts` is worse than gent's 34 modules. No consolidation was
  attempted toward a god-file.

## Net

Three removals, −685 lines. Eight rejected candidates, each with a receipt.
Five axes measured and closed: kernel codemode, actor operations, resource
host, extension buckets, storage tags.

The survey's top-ranked candidate is the one that survives as future work, and
it is a redesign rather than a deletion. Everything else it proposed has either
landed or been rejected with evidence.
