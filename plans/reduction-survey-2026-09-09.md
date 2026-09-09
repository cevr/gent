# Reduction survey — where gent's surface actually is

Date: 2026-09-09. Measured at HEAD `b0c4a78b`, `src` only (no tests, no
node_modules).

## Totals

| Package               |   Files |      Lines |
| --------------------- | ------: | ---------: |
| `packages/core`       |     201 |     45,497 |
| `apps/tui`            |     143 |     22,832 |
| `packages/extensions` |      56 |      9,419 |
| `packages/sdk`        |       7 |      1,036 |
| `packages/tooling`    |       9 |      1,386 |
| `apps/server`         |       2 |        794 |
| **total**             | **426** | **81,323** |

`packages/core-internal` has **no source of its own**.

## core/src by area

| Area            | Files |  Lines |
| --------------- | ----: | -----: |
| `runtime`       |    98 | 25,877 |
| `domain`        |    49 |  7,756 |
| `storage`       |    18 |  4,479 |
| `server`        |    19 |  4,176 |
| `test-utils`    |     9 |  1,832 |
| `providers`     |     3 |    503 |
| everything else |     4 |    802 |

`runtime` is 57% of core. Inside it:

| Area                 | Files |  Lines |
| -------------------- | ----: | -----: |
| `runtime/agent`      |    34 | 10,487 |
| `runtime/extensions` |    18 |  4,922 |
| `runtime/code-cell`  |    18 |  2,702 |
| `runtime/*.ts` flat  |    13 |  7,388 |
| `runtime/file-index` |     3 |    378 |

`runtime/extensions/resource-host` alone is 2,864 lines.

## Finding 1 — `core-internal` is a symlink, not a package

Correcting an earlier handoff that called it "109 files". It is:

```
packages/core-internal/
  package.json   (442 bytes)
  src -> ../core/src   (symlink)
```

Its `exports` are `"./*": "./src/*.ts"` — a wildcard alias over core's source.
Its entire job is to let tests and apps import core internals while
`@gent/core` exposes only the curated `extensions/api` surface.

**230 import sites** across 7 packages: extensions 40, tui 34, e2e 7, sdk 6,
core 6, tooling 5, server 2. By kind: 36 files in `src`, 61 in tests.

So deleting it removes **one package.json and a symlink**, not code. The cost
is 230 import rewrites and the loss of the public/internal boundary. That is a
rename, not a reduction — and it makes the boundary _weaker_. The concept is
worth keeping unless the public/internal split itself is being dropped.

## Finding 2 — codemode is already implemented, and correct

`cell-extension.ts:36-44` sets `toolPolicy: { include: ["cell"], modelSet:
["cell"] }`. The model is advertised **exactly one tool**. The other 18 are
delivered as a prose catalog in the system prompt (`cell-extension.ts:46-70`),
callable with `await tools.call(name, input)`.

The full JSON schemas never enter the model request: `buildCellCatalog`
(`cell-catalog.ts:16-30`) sends `AiTool.getJsonSchema` **to the kernel** over
the cell protocol (`cell-dispatch.ts:42`), out of band. The model sees one
line per tool. `tools.search`/`tools.describe` are local and synchronous.

This is the token win already banked. Remaining catalog cost is ~2,900 chars
of descriptions across 18 tools, one line each.

## Finding 3 — some host tools are Bun-shaped, not tool-shaped

With a Bun cell, a host tool earns its place only if it does something the
runtime cannot: permissions, durable records, an index, network auth, or child
agents. Tools that are thin wrappers over Bun built-ins cost a catalog line
and a JSON round-trip for no capability.

`glob` (`fs-tools/glob.ts`, 79 lines) is the clearest: it pulls `picomatch`
and filters `ctx.Files.listFiles`, against `Bun.Glob` in the runtime. Its own
guideline says "Use instead of bash find/ls" — advice aimed at a world without
a cell.

Keep tools that are genuinely better than raw Bun: `edit` (structured
replacement with real failure modes), `grep` (index-backed), `read` (paging +
durable ids), `webfetch`/`websearch` (network + auth), `delegate`/`agent-*`
(child agents), `ask_user` (interaction). Those are not reimplementable in a
cell without losing behavior.

## Finding 4 — provider extensions are half of `packages/extensions`

anthropic 2,842 + openai 1,921 = **4,763 of 9,419 lines**. The bulk is
credentials, not inference:

| File                              | Lines |
| --------------------------------- | ----: |
| `openai/oauth.ts`                 |   779 |
| `anthropic/keychain-client.ts`    |   576 |
| `openai/codex-transform.ts`       |   440 |
| `anthropic/keychain-transform.ts` |   422 |
| `openai/credential-service.ts`    |   377 |
| `anthropic/credential-service.ts` |   277 |

The two credential services are structurally parallel — same
`CredentialCacheCell`, `CredentialServiceApi`, `CredentialIO`,
`CredentialService` shape, differing only in provider name and token format.
Core has `providers/provider-auth.ts` (173) and `domain/auth.ts` (342), but
**no shared credential service**; each provider re-implements the cache,
refresh, and persistence dance.

## Finding 5 — `runtime/agent` is 34 files for one loop

9 `agent-loop.*`, 7 `turn-*`, 7 `agent-runner.*`, 4 `tool-*`, plus support.
Two of them exceed 1,100 lines (`agent-loop.handlers.ts` 1,186,
`agent-loop.turn-execution.ts` 1,144). This is the file-count fragmentation
the goal names directly.

Note: tool binding/replay (`tool-binding-resolution.ts`,
`tool-binding-replay.ts`, `process-local-tool-replay.ts`, 572 lines) is
**not** dead — it is what makes `tools.call` durable across cell replay.

## Open

Prior-art comparison (opencode v2, prime-agent, exo, deepseek-harness) is in
flight; conclusions land in a follow-up.
