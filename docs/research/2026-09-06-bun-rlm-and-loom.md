# Bun RLM and Loom research

Date: 2026-09-06. This report supports a Gent implementation plan.
No Gent or Loom runtime code changed in this research pass.

## Finding

Reuse Loom's proven Bun evaluation and process-recovery design. Do not import
the complete Loom daemon into Gent. Replace Gent's existing executor integration
with one model-facing code cell after the host-policy and recovery checks pass.
The goal is fewer execution paths and fewer dedicated workflow tools, not a
second agent engine.

## Current evidence

Loom is clean at `1bea365fdf486d621dc3d8a2730b056790f4918a`.
Its Pi adapter registers only `loom_cell`. Its persistent TypeScript environment
uses Bun.Transpiler with replMode and node:vm. It supports top-level await,
retained bindings, captured output, and structured file-change results.

The worker handles cells in order. The parent owns startup, timeout, replacement,
diagnostics, and the durable Cell Ledger. Mutable bindings do not survive worker
replacement. Cells are not replayed automatically. A compile/runtime error keeps
the worker; timeout, exit, interruption, or protocol failure replaces it.

The current host object is not reusable unchanged. File controls are local to
the worker. Runtime controls connect to `.loom/daemon.sock` and use Loom IDs and
protocols. The evaluation context exposes Bun and permits dynamic imports.
Neither node:vm nor the worker process is a security sandbox.

Sources:

- `/Users/cvr/Developer/personal/loom/docs/adr/0014-expose-one-model-facing-code-cell.md`
- `/Users/cvr/Developer/personal/loom/docs/architecture.md`
- `/Users/cvr/Developer/personal/loom/docs/code-kernel-recovery.md`
- `/Users/cvr/Developer/personal/loom/packages/pi-extension/src/internal/cell-tools.ts`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel.ts`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel-worker.ts`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel-control.ts`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel-runtime-control.ts`
- `/Users/cvr/Developer/personal/loom/packages/protocol/src/cell-evaluation.ts`
- `/Users/cvr/Developer/personal/loom/packages/protocol/src/protocol-version.ts`

Executed from Loom's `packages/platform-bun`:

`bun test tests/code-kernel.test.ts tests/code-kernel-process.test.ts`

Result: 20 pass, 0 fail. Receipt: `/tmp/gent-loom-kernel-research-tests.log`.
This is not a full Loom gate or proof of Gent integration.

## Prior-art decisions

| Source           | Take                                                                                               | Do not copy                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| FX               | Small kernel interface; bounded output; explicit cancellation; generation-bound tool use           | A second agent loop or a second application transport                                       |
| Pi               | Distinct steering/follow-up admission; staged registration; stale-context rejection; project trust | A second durable lane engine or assumed parity for every client UI                          |
| OpenCode         | Typed provider events; replay identity/order checks; interrupted tool states                       | Volatile-only approvals, whole-instance reload as the default, a large provider catalog     |
| DeepSeek Harness | Explicit dependency generations and ordered cleanup                                                | Cordis beside Effect or claims that scope cleanup reverses external writes                  |
| Exo              | Durable desired/applied revisions; repair control outside replaced execution                       | A self-rebuild daemon or automatic source rollback claims                                   |
| Prime Agent      | Persistent programming surface; host-owned recursive children; small admission handles             | Python provisioning, a second provider stack, or assumptions about safe namespace snapshots |
| Loom             | Bun cell evaluation, structured results, bounded process recovery, foreground leases               | Loom daemon, Job/Workflow/Goal stores duplicated inside Gent                                |

The first five source snapshots and detailed receipts are in
`docs/research/2026-09-06-malleability-and-harness-prior-art.md`.

Prime's current documentation separates the Python kernel from the TypeScript
host. Child creation returns an admission handle; answers arrive later. Host
requests and replies travel while a cell runs. The kernel is not a sandbox.
These are documentation observations, not executed Prime checks.

- [Prime RLM programming model](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)
- [Prime runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)
- [Bun replMode contract](https://bun.sh/reference/bun/TranspilerOptions/replMode)

Prime cache fetch failed with git exit 128. Raw GitHub documentation was read
instead. It is a moving-main source, unlike the pinned earlier research.
Bun's documented replMode transforms support persistent declarations and result
capture. The actual Loom test run is the stronger local compatibility evidence.

## Gent fit

Gent's executor already provides code mode: the model writes code that composes
host tools. Preserve this design. The proposed RLM kernel adds retained working
data and recursive child calls. It does not replace code mode with a different
agent engine. The user identifies OpenCode's code mode as a related reference.

Gent's current executor adds an external binary, HTTP port discovery, process
registry, MCP transport, execute/resume result normalization, and a controller.
These are candidates for replacement, not foundations to wrap again.

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/index.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/sidecar.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/mcp-bridge.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/tools.ts`

One lazy worker belongs to a Gent session/branch execution owner. Branch switches
must not share mutable bindings. Host operations use Gent's existing tool,
interaction, process, child-session, and resource-generation owners. Keep canonical
operation receipts inside cell results so compact UI does not conceal effects.

Expose one `cell` tool in the new default model profile. Existing tools can remain
host-callable without also appearing as duplicate model tools. Keep human commands
and typed RPC. The host catalog generates callable descriptions and validation;
do not maintain a second handwritten schema catalog.

Recursive use must create real Gent child sessions through the existing runner.
Return a handle after admission. Bound child depth, parallelism, output, and waits.
Attribute usage once. Child completion must not require a kernel to remain alive.

## Required design proofs

1. Separate serial cell admission from host-reply dispatch. A cell awaiting a
   host reply must not block the reader that delivers that reply.
2. Host calls pass through existing permission checks and generation leases.
   A cell is not blanket approval for every operation inside it.
3. Do not expose host credentials through the worker environment or bridge.
4. Removal of ambient globals is not proof of confinement. Prove the selected
   isolation contract before replacing a restricted execution path. Any trusted
   host-code mode needs explicit trust and an honest permission model.
5. On lost worker/host connection, mark ambiguous effects as unknown. Do not
   retry a cell automatically. Operation IDs prevent only the duplicate effects
   for which the owning host operation actually supports deduplication.
6. Long jobs return handles under a foreground lease. Cell timeout and job
   cancellation are separate operations.
7. Preserve variables across turns and model compaction. On reset/crash, retain
   receipts and durable children/jobs, but explicitly report lost bindings.

## Reuse and reduction rules

Extract only a demonstrated shared kernel seam from Loom, with injected host
operations. Do not publish a private monorepo package unchanged: the current
platform package depends on Loom runtime, protocol, domain, and client packages.
Keep the Pi consumer working through the same implementation. Validate both
consumers before claiming reuse reduced maintenance.

Use Effect Machine only for generic local lifecycle ownership when needed.
Use Effect Encore for durable commands. Fix generic defects in owned libraries,
with Changesets and the approved release flow, rather than local workarounds.
Do not place Bun evaluation inside a platform-neutral state-machine library.

Track deleted runtime lines, added runtime lines, test lines, dependencies,
public interfaces, and process/control owners separately. Moving code to Loom
does not count as a combined LOC reduction. Do not delete guarantees to meet a
line target. The implementation plan is `plans/bun-rlm-and-harness-reduction.md`.
