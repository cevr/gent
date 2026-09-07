# Bun process isolation check

## Initial expression check

This is a local design check, not a production security claim.
It used Bun 1.4.0 and `/usr/bin/sandbox-exec` on the current macOS host.
No runtime code changed. No worker is integrated into Gent.

The check launched `/Users/cvr/.bun/bin/bun -e <source>` with an empty environment
through `/usr/bin/env -i /usr/bin/sandbox-exec -p <profile>`. Its cwd was `/tmp`.

Profile that started Bun:

```scheme
(version 1)
(deny default)
(allow dynamic-code-generation)
(allow file-map-executable)
(allow file-read-metadata)
(allow process-exec (literal "/Users/cvr/.bun/bin/bun"))
(allow file-read*
  (literal "/")
  (literal "/Users")
  (literal "/Users/cvr")
  (literal "/Users/cvr/.bun")
  (literal "/Users/cvr/.bun/bin")
  (literal "/Users/cvr/.bun/bin/bun")
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (literal "/dev/urandom")
  (literal "/dev/null"))
(allow sysctl-read)
```

Removing the literal parent-directory read grants caused exit 134 before the
evaluation. Adding them allowed startup. No Mach lookup permission was needed
for this check. A production profile must resolve paths rather than hardcode them.

Observed results:

| Operation                                  | Result                              |
| ------------------------------------------ | ----------------------------------- |
| Bun.Transpiler, TypeScript replMode        | Compiled successfully               |
| Object.keys(process.env)                   | Empty array                         |
| Read Gent package.json with Bun.file       | EPERM                               |
| Write /tmp/gent-rlm-denied-write-proof.txt | EPERM; file did not exist afterward |
| Bun.spawn /usr/bin/true                    | EPERM                               |
| fetch http://127.0.0.1:9                   | FailedToOpenSocket                  |
| Dynamic import of Gent package.json        | ERR_MODULE_NOT_FOUND                |

The network probe did not use a live test listener. Repeat it against a known
working listener before treating it as an end-to-end network denial test.
The import failure alone does not prove every import route is contained.
This profile allows directory listings at the named parent paths and metadata
reads. It is not a claim that all host metadata is hidden.

Next checks: live host replies during evaluation; packaging and trusted worker
loading; bounded frames/output; cancellation and process loss; Linux support;
direct built-in filesystem/network/process access; complete denial tests against
known working controls. Do not change the default executor until those checks pass.

Design source receipts:

- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel.ts`
- `/Users/cvr/Developer/personal/loom/packages/platform-bun/src/internal/code-kernel-worker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/tools.ts`
- `/usr/share/sandbox/com.apple.spotlightknowledged.importer.sb`

## Built worker check, 2026-09-07

Built the actual private worker entry with:

`bun build packages/core/src/runtime/code-cell/main.ts --target=bun --outfile /tmp/gent-cell-worker.VJnj5a/worker.js`

The bundle contains 127 modules and is 0.85 MB. SHA-256:
`dd84668fdd9c8a084c8ace5861ab66309ca00d0898df75caef7d529bb892cca8`.

Ran `/tmp/gent-cell-worker.VJnj5a/probe.mjs` with Bun. The probe now imports
Gent's `makeMacosCellSandboxProfile` directly. It supplies canonical runtime and
worker paths. It launches the worker with an empty environment and uses its
real stdin/stdout protocol. Probe SHA-256:
`883729d9129231fa22fd2d2cc74bfb448cb1238963b4bdbee8ea89be983c0d45`.

Results:

- Ready, host call/reply, retained values, and reset passed.
- The worker environment had zero keys.
- Bun.file read of Gent package.json returned EPERM.
- Bun.write to the probe directory returned EPERM. No file was created.
- Spawning /usr/bin/true returned EPERM.
- Spawning another copy of the same Bun binary returned EPERM.
- Fetch to a live parent-owned loopback server returned FailedToOpenSocket.
  The parent fetched that server successfully before and after the denial check.
- Dynamic import returned ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING.
- A require-based read failed because require was not defined.

The final two results are VM/module-access restrictions, not OS filesystem
denial evidence. The probe deliberately obtained Bun and fetch through an
injected function's constructor. The OS restrictions still applied.

The probe stopped the child and awaited exit. It also stopped its local server.
The temporary bundle and probe remain at the listed paths for inspection.

Added three profile tests for exact paths, escaped path literals, and rejection
of relative paths. All passed. Full gate exited 0:
`/tmp/gent-rlm-sandbox-gate.log`. `git diff --check` passed.

This remains a macOS result. It does not prove Linux support, memory limits,
process-owner recovery, durable approvals, or the final model-tool integration.
The profile permits metadata reads and named parent-directory listings. The
parent must canonicalize and validate trusted artifact paths before launch.

Current source receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-sandbox.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/main.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/cell-worker.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/code-cell/bun-evaluator-boundary.ts`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/cell-sandbox.test.ts`
