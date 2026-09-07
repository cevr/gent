# Shared Bun cell extraction

## Ownership

The isolated Loom checkout is
`/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator`.
Its base is `1bea365fdf486d621dc3d8a2730b056790f4918a`.
The warm Loom checkout remains unchanged.

The new `@cvr/bun-cell` package owns only persistent cell evaluation. It has no
Loom import, process launcher, daemon, scheduler, agent engine, or durable store.
It exports TypeScript source for Bun consumers. Effect is its only runtime peer.
Its peer range names the two checked versions: `4.0.0-beta.106` and
`4.0.0-rc.112`.

The public constructor accepts worker-local globals and a source limit. Optional
native callbacks supply module loading and final-value formatting. Without a
loader, VM module imports fail. These callbacks preserve the host's resolution
base and result display. They do not provide a security boundary.

The evaluator owns bounded console output, compilation, top-level await, retained
bindings, reset, and typed source/compile/execution errors. Host-specific adapters
keep tools, permissions, process isolation, deadlines, crash replacement, durable
receipts, and file-change metadata. No shared process supervisor was added.

Loom's adapter now consumes this package through a declared workspace dependency.
It preserves its `loom` controls, native Bun access, module loader, quoted result
display, file-change records, and process recovery. Gent has no dependency change
yet. It must consume a published version, not a cross-repository local link.

## Evidence

The clean Loom Rift passed its baseline gate:
`/tmp/loom-cell-extraction-baseline-gate.log`.

After extraction, 23 focused tests passed with 53 assertions. They cover the
shared evaluator, Loom's existing evaluation tests, and real worker recovery.
The existing 5,000-line file-write and structured preview check passed.

The full Loom gate exited 0:
`/tmp/loom-cell-extraction-verified-gate.log`.
All 11 test tasks passed, including Pi and daemon consumers.

The full unchanged Gent code gate also exited 0:
`/tmp/gent-shared-cell-check-gate.log`.

The final package was packed and installed in a separate temporary consumer:
`/tmp/bun-cell-release-proof.l2h0FU`.
The archive is `cvr-bun-cell-0.0.0.tgz`.
Its SHA-1 is `05ff25fcaea512dd8083d5180a6cc2641c731c75`.
It contains five files, with no Loom packages or tests in the archive.
Three package tests passed with 14 assertions against Effect `4.0.0-rc.112`.
The temporary consumer passed TypeScript checking with Gent's compiler.
This is package compatibility evidence, not proof of Gent worker integration.

The temporary test install reports a prerelease peer warning. Its test helper,
`effect-bun-test@0.3.0`, declares `effect >=3.19.0`; the shared package explicitly
permits the tested RC. No peer override was added to hide the warning.

These checks used the installed Bun `1.4.0` binary. Loom's AGENTS file asks for
the 1.4 canary. This run does not establish a separate canary validation result.

## Size and delivery limits

Loom's former evaluator had 183 raw source lines. Its new adapter has 70 lines.
The shared package has 139 raw source lines, including its schemas and exports.
The combined extraction scope therefore has 209 lines, an increase of 26.
No relocation is counted as a reduction. Removing Gent's duplicate evaluator
after published integration must establish the final combined result.

A minor Changeset exists for `@cvr/bun-cell`. Loom did not have Changesets release
configuration or a GitHub release workflow. This turn did not add or run that
flow. Publication, downstream integration, and a live Pi check remain unfinished.
No commit, push, merge, or publication occurred.

The architecture skill kept host policy outside the evaluator. The Effect skill
kept typed failures and serialization inside the evaluator. The Turborepo skill
kept the dependency declared and checks local to the package.

## Source paths

- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/AGENTS.md`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/CONTEXT.md`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/docs/architecture.md`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/docs/adr/0005-supervise-code-kernels-as-bun-processes.md`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/docs/adr/0007-bound-code-kernel-failures-and-diagnostics.md`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/docs/adr/0014-expose-one-model-facing-code-cell.md`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/package.json`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/bun.lock`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/tsconfig.json`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/turbo.json`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/oxlint.config.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/bun-cell/package.json`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/bun-cell/src/index.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/bun-cell/src/cell.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/bun-cell/src/evaluator-boundary.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/bun-cell/tests/evaluator.test.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/platform-bun/package.json`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/platform-bun/src/internal/code-kernel.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/platform-bun/src/internal/code-kernel-control.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/platform-bun/src/internal/code-kernel-worker.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/platform-bun/tests/code-kernel.test.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/platform-bun/tests/code-kernel-process.test.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/protocol/src/cell-evaluation.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/protocol/src/cell-compilation-error.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/protocol/src/cell-execution-error.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/packages/protocol/src/protocol-version.ts`
- `/Users/cvr/Developer/personal/.rifts/loom/bun-cell-evaluator/.changeset/shared-bun-cell.md`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/bun-evaluator-boundary.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/plans/bun-rlm-and-harness-reduction.md`
- `/tmp/bun-cell-release-proof.l2h0FU/package.json`
- `/tmp/bun-cell-release-proof.l2h0FU/evaluator.test.ts`
- `/tmp/bun-cell-release-proof.l2h0FU/tsconfig.json`
- `/tmp/bun-cell-release-proof.l2h0FU/node_modules/effect-bun-test/package.json`
