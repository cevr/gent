# Bun RLM source baseline

Measured after the inactive runner and its unused settings were removed.
Rift: `/Users/cvr/Developer/personal/.rifts/gent/fx-ui`.
HEAD: `a826c36417d7c209d85ef325911365a608ff43e4`.
The checkout contains prior uncommitted FX and architecture changes.
Do not use the full HEAD diff as this goal's reduction count.

| Scope                                                    | Files | Raw lines |
| -------------------------------------------------------- | ----: | --------: |
| Runtime TS/TSX under apps and packages `src` directories |   445 |    86,965 |
| TS/TSX under test, tests, or **tests** directories       |   287 |    71,502 |
| JSON under src directories                               |     7 |     1,198 |
| Package manifests under apps and packages                |     8 |       203 |

Counts include comments and blank lines. File discovery used `rg --files packages
apps`. It includes visible untracked files and excludes ignored files. Lines are
newline-separated records, without an extra record for a trailing newline.

For each category, sort paths and hash each relative path, a NUL byte, and its
file bytes with SHA-256. The measured category hashes are:

- Runtime: `720f5f58536aabb583f38b9b57df9f910e4ef4f5cc5896eaf394d453a43bd431`
- Tests: `1ad0d7ea7c2ca84fb77ff65a3a50259729d14beaf997d59906ba962987539f92`
- Data: `683146dc6783ba06abf1e3c81a6de635182c6e5ced79dea517677a233c806626`
- Manifests: `0ad481f21ba7dae0716d59ee64abcb49666b1d208fde8571ee7e7bd0d0e810bb`

The two cleanup steps removed 244 runtime lines. No runtime lines were added.
Thus the runtime baseline before these steps was 87,209 lines, with the same
file count. This reconstruction covers only the exact edits in the progress
receipt. No dependencies were added or removed by these steps.

Removed concepts: the selectable subprocess agent runner, its binary-path option,
and its database/server-URL configuration propagation. The normal runner still
owns durable and ephemeral children. The shared server remains in use.

Loom has no edits from this goal. Its pinned source and kernel test receipts are
in `docs/research/2026-09-06-bun-rlm-and-loom.md`. If shared code moves later, record
the affected Loom/library baseline before editing it. Report combined reduction
within the replacement scope as well as the full Gent count.

Source receipts are listed in `plans/bun-rlm-progress.md`. The old Executor and
workflow source sets are listed in `docs/research/2026-09-06-gent-trim-candidates.md`.
