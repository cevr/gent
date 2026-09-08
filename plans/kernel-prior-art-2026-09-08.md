# Kernel prior art, 2026-09-08

Keep the workflow commands as prompt recipes. Remove their fixed child counts and fixed review sequence. Keep the current artifact calls until a durable replacement can serve the same UI. Use kernel variables for working data. Use files for large results and child handoffs. Keep resource control and approval in the host.

This is a recommendation. The source observations below support it. This review changed no code. It did not run either external system.

**Source revisions**

| Source               | Revision checked                           | Scope                                                                                                           |
| -------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Gent                 | `4e885c4b9731cd01f734ab8086788d717573155a` | Baseline before the concurrent workflow edit. Gent source links below use this commit.                          |
| Prime Agent cache    | `a3b3e753490d0a6ed180e905200c1a6690d78608` | Clean cache at `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent`. Commit date: 2026-08-11.                 |
| Prime Agent remote   | `bf8894afa55832f7cfa2094c8a0d041bc680a691` | `git ls-remote origin HEAD refs/heads/main` returned this commit for both refs on 2026-09-08.                   |
| RLM paper            | arXiv `2512.24601v2`                       | Official versioned paper. Section 2 and Algorithm 1.                                                            |
| Cloudflare Code Mode | Official docs read on 2026-09-08           | The durable runtime guide reports an update on 2026-07-22. These documentation URLs are not pinned Git commits. |

The Prime cache is older than remote main. I left it unchanged. I read the selected current files through pinned `raw.githubusercontent.com` URLs. The prompt, snapshot contract, runtime adapter, and harness file all differ from the cache. Current observations below use the remote pin when that difference matters.

**Observed: Prime Agent**

- The cached prompt uses a persistent Python kernel for variables, helper functions, parsed results, and tool composition. It treats the external project's runtime as a separate system. The current prompt keeps this division. It adds an instruction to store large data on disk. See [P1] and [U1].
- The cache serializes each user binding with `dill`. It omits values that fail serialization or exceed the 256 MiB total cap. It writes a payload and a manifest in the session artifact directory. The current contract adds a 16 MiB per-variable cap. See [P2] and [U2].
- Current snapshot code lives in the Python REPL module. The TypeScript manager requests a snapshot after a successful cell. It reports omitted names. Explicit compaction can remove oversized live variables after the snapshot files commit. Thus the snapshot is a recovery mechanism with known loss cases. See [U3] and [U4].
- `rlm()` returns a child handle after admission. It does not return the child's final answer. Messages and files carry results. The host owns child creation, completion, release, and deletion. A fresh kernel can recover handles through the host registry. See [P3], [P4], [U1], and [U5].
- The current prompt tells the model to record a handle or output path for slow work. It then ends the turn. It uses children when independent work warrants them. It handles a known lookup or small edit directly. This is model guidance. It does not prove that every operation has a time bound. See [U1].
- Reusable prompts, memories, skills, and child specifications have file-backed harness records. They are not only kernel variables. The current harness checks file modification time so it can reload changed records. It writes through a temporary file and replacement. See [P5] and [U6].
- User workflow commands can be Markdown prompt templates. The cached guide describes slash expansion and arguments. It does not prescribe a separate workflow engine for a review prompt. See [P6].
- Prime uses the term `session-artifacts` for the directory that contains kernel snapshots, schedule state, and scratch files. This is not evidence of a Gent-style typed artifact UI store. See [P7].

**Observed: RLM paper**

The paper places the input in a persistent external REPL. The model receives metadata about the input. Code can inspect the input, create intermediate values, and call a sub-RLM on computed slices. Intermediate values remain in variables. The result can also come from a variable. This makes programmatic recursion useful without placing each large result in model history. Section 2 does not define a production artifact database, approval system, or restart contract. Those concerns need a separate design. See [R1].

**Observed: Cloudflare Code Mode**

Cloudflare exposes tool methods to generated code. Search and describe can load selected definitions. This lets code combine calls and reduce results before they enter model context. See [C1].

Its durable runtime stores execution records, connector call logs, pending approvals, and snippets in host SQLite storage. Executor and connector instances remain temporary. Approval stops a pass. A later pass replays recorded calls before it runs the approved action. Replay requires stable call order. The guide warns that parallel calls can change that order. This is a different recovery contract from Gent's rule against source replay. See [C2].

The documented Worker executor blocks external network access by default. The Worker runtime enforces that block. The host grants controlled access through methods or an outbound service. This is a property of that executor. It is not a property of arbitrary code execution. See [C3].

**Observed: Gent baseline**

| Concern             | Current owner                                                                                                                                  | Evidence     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Working variables   | One cell kernel for the branch.                                                                                                                | [G1], [G2]   |
| Namespace recovery  | The host stores the last good snapshot by session and branch in SQLite.                                                                        | [G2], [G3]   |
| Snapshot coverage   | 256 KiB per binding. 768 KiB total. Functions, cycles, unsupported values, deep values, and large values can be omitted.                       | [G4]         |
| Snapshot timing     | The host snapshots after successful evaluation. Snapshot failure logs a warning. It does not fail the completed cell.                          | [G2]         |
| Cell failure        | A later cell can restore the last good snapshot. An incomplete cell does not replay its source. Explicit reset clears the saved namespace.     | [G2]         |
| Tool composition    | Kernel code calls `tools.call`. Search and describe use the selected catalog in the worker. Context methods call the host.                     | [G1]         |
| Resource control    | The host owns the worker scope, cell serialization, compute deadline, and host-call dispatch.                                                  | [G12]        |
| Child work          | `delegate` supports foreground output and background admission. The host records background children. `agent-children` recovers their handles. | [G5], [G6]   |
| Workflow commands   | Requests queue prompt text. Fixed child sequences live in that text. No workflow execution engine lives in this extension.                     | [G7]         |
| Published artifacts | A process `Ref` stores full content and metadata. Save replaces the artifact for the same source and branch. Reads enforce branch scope.       | [G8], [G9]   |
| Artifact UI         | The client reads the artifact RPC and refreshes on extension state changes. It does not read the cell namespace.                               | [G10], [G11] |

An approval request can suspend a cell. Gent then restores the last good namespace for later work. A plan that exists only in the suspended cell has not reached the successful-cell snapshot. Finish the cell that stores the plan before a separate approval call. A successful cell still does not prove its snapshot write succeeded. See [G2], lines 128-137, 217-248.

The evaluator installs `require` from the project working directory. A prompt that asks a reviewer to use read tools does not establish an operating-system read-only boundary. Keep read-only instructions. Do not describe them as enforced isolation. See [G1], lines 180-185.

**Recommendation: the immediate workflow change**

The proposed change has the right scope. Keep the five slash commands and their request IDs. Change only the recipes, their descriptions, and the checks that cover their behavior.

| Command        | Required result                                                                    | Rule to keep                                                                                                |
| -------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/plan <task>` | A concrete plan with risks, alternatives, checks, and commit batches where useful. | Save the final plan through the current artifact API. Finish that cell. Request approval before code edits. |
| `/plan`        | The saved plan for this branch.                                                    | Retain `artifact_read` with source `plan`. Do not start new planning work.                                  |
| `/review`      | Supported findings with file, line, severity, and a proposed correction.           | Keep the work read-only unless the user asks for fixes. Save the final review for the current UI.           |
| `/audit`       | Evidence of defects or risks in the given scope.                                   | Keep the work read-only. Save and report the result. Do not require concern discovery before each audit.    |
| `/counsel`     | An independent second opinion.                                                     | Keep the different-model preference when available. Give the child a complete task prompt.                  |
| `/research`    | An answer with primary-source citations.                                           | Fetch code when the question needs code. Delegate independent reading when it adds value.                   |

Remove the mandatory two-plan, two-cross-review, one-synthesis sequence. Remove the two-audits-per-concern rule. Remove the one-cell rule for an entire workflow. The model can still use those steps when the task needs them. The recipe should state the result and constraints. See [G7], [P6], and [U1].

Retain working data in named kernel variables. Put large or shared results in files. Save only the final supported result in the current artifact UI. Do not publish a failed child result as a completed review. The existing delegate result distinguishes running, completed, and error states. A completed child turn is not proof of task success. See [G5] and [G6].

Use Gent's current child API. `background: true` already returns a durable handle. Foreground delegation already returns output. This work does not need a new child scheduler, wait API, workflow actor, or replay engine. See [G5] and [G6].

Run `bun run gate` and a live Herdr TUI check after each logical code change. Repeat both after a corrective change. Prompt checks verify queued instructions. The live check must also verify the visible result, saved output, and approval behavior.

**Recommendation: where future state should live**

| State                                                                                                      | Proposed location                                     | Reason                                                                                              |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Scratch arrays, parsed search results, temporary plans, helper functions                                   | Kernel variables                                      | Code can compose and reduce them without repeated model output. Their loss must remain recoverable. |
| Large source data, full reports, child handoffs, deliverable files                                         | Files                                                 | They exceed the snapshot budget or need access from more than one branch or process.                |
| Published artifact identity, scope, revision, status, and content reference, if the dedicated view remains | One durable host-owned record, exposed to kernel code | The UI must read it without a live kernel. Publication must return a durable receipt.               |
| Cell process, timeout, cancellation, host calls, approvals, child registry                                 | Host services                                         | These services must work when the kernel stops or a binding disappears.                             |
| Repeated review or research procedure                                                                      | Prompt recipe or skill file                           | The model can adapt the procedure to the task. No runtime state is required for plain instructions. |
| Long-lived child or process output                                                                         | Host-managed output file plus a stable handle         | A lost variable must not orphan running work.                                                       |

For kernel-backed artifacts, make kernel values the source of the work. Give publication an explicit durable boundary. If the dedicated artifact view remains, its published value can have inline content or a file reference. Keep one authoritative record for that view. Avoid keeping a second mutable copy in the extension `Ref`.

The proposed file-only cutover is smaller if Gent removes the dedicated artifact API and badge. In that design, the saved file is the durable owner. It does not need a new artifact record service. The existing transcript can show the path and summary. This changes the product surface. It must remain explicit. See [D1].

The first draft had three file design gaps. Empty `/plan` needed a stable location after a custom path choice. A mutable `<kind>.md` path could not preserve the content of an earlier transcript link. An interrupted overwrite could destroy the last accepted plan. The revised draft selects a canonical branch file plus explicit export. It states that old links show current content. It requires atomic replacement before cutover. These changes resolve the plan gaps. The current writer still calls `fs.writeFileString` through the file facade; the atomic mode remains future work. See [D1], lines 65-87, and [G13]-[G14].

Use the existing recorded file tool path for these writes. Do not add the write to `context.*`: the current host dispatch sends that namespace around tool admission. The draft's rule against copying the latest namespace into an earlier fork is correct. The fork path creates a branch and copies messages through the selected point. It does not copy a historical namespace. See [G15]-[G16].

An ordinary namespace binding does not yet meet that contract. It can exceed a limit. Another binding can consume the remaining total budget. An explicit reset removes its stored snapshot. Snapshot errors do not fail the cell. A new published-value contract must either protect committed entries from these cases or use a durable host write. Increasing snapshot limits alone does not fix the ownership problem. See [G2]-[G4], [G8], [U2]-[U4].

Do not copy Prime's 16 MiB limit into Gent without measurement. Its kernel language and serializer differ. Do not copy Cloudflare's approval replay without its call log and ordering contract. Neither choice is required to simplify the workflow recipes. See [G4], [U2], and [C2].

**Recommendation: deletion order**

1. Delete fixed workflow choreography now. Keep the existing command registration. This removes policy text without changing storage or child lifetime.
2. Define the saved-result contract. Choose the file-only view or the dedicated artifact view. Prove branch scope, restart recovery, explicit reset behavior, large content, and reads without a worker.
3. Route artifact reads and writes through that single durable owner. Keep the current RPC during this step. Then delete the process `Ref` and its duplicate mutation paths in the artifact store.
4. Remove redundant model-facing artifact tools only when the selected replacement covers their uses. Delete the transport view with the badge in the file-only design. Keep it if a client still requires it.
5. Consider moving workflow bodies into data or skill files only when command loading already supports it. The present helper is small. Do not add a template engine only to delete five functions.

The first step is supported by [G7]. The artifact steps follow the gap between [G2]-[G4] and [G8]-[G11]. The final step follows the simple prompt-template precedent in [P6]. These are proposed changes. This review does not claim that later deletions are already safe.

Keep the host child registry and cell execution ledger. They carry lifetime and recovery information that kernel variables cannot replace. The existing child tools already give the model access to that information. See [G2], [G5], [G6], and [P3].

**Source receipts**

All Gent local paths below refer to the baseline named above. Concurrent work can change local line numbers. The linked GitHub versions preserve the cited baseline. Prime local paths refer to the unchanged cache pin. Files under `U` were read from the current remote pin and were not written into the cache.

| Ref | Full local source path and lines                                                                                                    | Pinned source                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/bun-evaluator-boundary.ts`, lines 116-194                   | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/runtime/code-cell/bun-evaluator-boundary.ts#L116-L194)                      |
| G2  | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-execution.ts`, lines 116-181, 189-275                  | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/runtime/code-cell/cell-execution.ts#L116-L275)                              |
| G3  | `/Users/cvr/Developer/personal/gent/packages/core/src/storage/cell-namespace-storage.ts`, lines 31-75                               | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/storage/cell-namespace-storage.ts#L31-L75)                                  |
| G4  | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-snapshot.ts`, lines 10-17, 83-93, 158-198              | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/runtime/code-cell/cell-snapshot.ts#L10-L198)                                |
| G5  | `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts`, lines 18-69, 81-125                         | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/delegate/delegate-tool.ts#L18-L125)                                   |
| G6  | `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/child-agent-tools.ts`, lines 26-83                             | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/delegate/child-agent-tools.ts#L26-L83)                                |
| G7  | `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`, baseline lines 21-72, 85-105                             | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/workflows.ts#L21-L105)                                                |
| G8  | `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/store.ts`, lines 84-139, 187-238                              | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/artifacts/store.ts#L84-L238)                                          |
| G9  | `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/index.ts`, lines 31-98, 123-175                               | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/artifacts/index.ts#L31-L175)                                          |
| G10 | `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/artifacts.client.ts`, lines 30-58                              | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/apps/tui/src/extensions/builtins/artifacts.client.ts#L30-L58)                                 |
| G11 | `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts-protocol.ts`, lines 80-148                                    | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/artifacts-protocol.ts#L80-L148)                                       |
| G12 | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-kernel.ts`, lines 71-126, 192-255                      | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/runtime/code-cell/cell-kernel.ts#L71-L255)                                  |
| G13 | `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts`, lines 43-76                                         | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/fs-tools/write.ts#L43-L76)                                            |
| G14 | `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`, lines 360-365                                  | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/domain/extension-services.ts#L360-L365)                                     |
| G15 | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-tool-host.ts`, lines 91-143                            | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/runtime/code-cell/cell-tool-host.ts#L91-L143)                               |
| G16 | `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-mutations-live.ts`, lines 283-344                              | [Source](https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/server/session-mutations-live.ts#L283-L344)                                 |
| D1  | `/Users/cvr/Developer/personal/gent/plans/kernel-backed-artifacts-and-simplification.md`, draft lines 65-105 read on 2026-09-08     | [Local draft](/Users/cvr/Developer/personal/gent/plans/kernel-backed-artifacts-and-simplification.md:65)                                                                          |
| P1  | `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent/packages/coding-agent/src/core/prompts/rlm.ts`, lines 14-33, 126-149, 174-198 | [Cached revision](https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/prompts/rlm.ts#L14-L198)          |
| P2  | `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent/packages/coding-agent/src/core/kernel/state-snapshot.ts`, lines 1-44, 74-131  | [Cached revision](https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/kernel/state-snapshot.ts#L1-L131) |
| P3  | `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent/packages/coding-agent/src/core/rlm-runtime.ts`, lines 151-198, 205-241        | [Cached revision](https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/rlm-runtime.ts#L151-L241)         |
| P4  | `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent/packages/coding-agent/src/core/agent-session.ts`, lines 9170-9264             | [Cached revision](https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/agent-session.ts#L9170-L9264)     |
| P5  | `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent/prime-agent-runtime/src/rlm/harness.py`, lines 77-104, 187-198, 285-299       | [Cached revision](https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/prime-agent-runtime/src/rlm/harness.py#L77-L299)                 |
| P6  | `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent/packages/coding-agent/docs/prompt-templates.md`, lines 1-33, 55-72            | [Cached revision](https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/docs/prompt-templates.md#L1-L72)           |
| P7  | `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent/packages/coding-agent/src/core/session-file-actions.ts`, lines 13-22, 59-62   | [Cached revision](https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/session-file-actions.ts#L13-L62)  |

| Ref | Current official source                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | [Prime prompt, lines 14-51 and 156-223](https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/packages/coding-agent/src/core/prompts/rlm.ts#L14-L223)                                    |
| U2  | [Prime snapshot contract, lines 1-47](https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/packages/coding-agent/src/core/kernel/state-snapshot.ts#L1-L47)                              |
| U3  | [Prime REPL snapshot, lines 629-783](https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/prime-agent-runtime/src/rlm/repl.py#L629-L783)                                                |
| U4  | [Prime kernel manager, lines 856-863, 1472-1542, and 1578-1587](https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/packages/coding-agent/src/core/kernel/repl-manager.ts#L1472-L1587) |
| U5  | [Prime host child interfaces, lines 249-264 and 306-320](https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/packages/coding-agent/src/core/rlm-runtime.ts#L249-L320)                  |
| U6  | [Prime file-backed harness, lines 80-93, 189-199, and 287-318](https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/prime-agent-runtime/src/rlm/harness.py#L80-L318)                    |
| R1  | [Recursive Language Models, v2, Section 2 and Algorithm 1](https://arxiv.org/html/2512.24601v2#S2)                                                                                                                                |
| C1  | [Cloudflare Code Mode: code as a plan and progressive discovery](https://developers.cloudflare.com/agents/tools/codemode/)                                                                                                        |
| C2  | [Cloudflare Code Mode: durable runtime, approvals, and deterministic replay](https://developers.cloudflare.com/agents/tools/codemode/how-it-works/)                                                                               |
| C3  | [Cloudflare Code Mode: Worker network isolation](https://github.com/cloudflare/agents/blob/main/packages/codemode/README.md#network-isolation)                                                                                    |

Review guidance came from `/Users/cvr/Developer/personal/dotfiles/skills/research/SKILL.md`, `/Users/cvr/Developer/personal/dotfiles/skills/repo/SKILL.md`, `/Users/cvr/Developer/personal/dotfiles/principles/never-block-on-the-human.md`, and `/Users/cvr/Developer/personal/dotfiles/principles/redesign-from-first-principles.md`.

[G1]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/runtime/code-cell/bun-evaluator-boundary.ts#L116-L194
[G2]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/runtime/code-cell/cell-execution.ts#L116-L275
[G3]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/storage/cell-namespace-storage.ts#L31-L75
[G4]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/runtime/code-cell/cell-snapshot.ts#L10-L198
[G5]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/delegate/delegate-tool.ts#L18-L125
[G6]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/delegate/child-agent-tools.ts#L26-L83
[G7]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/workflows.ts#L21-L105
[G8]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/artifacts/store.ts#L84-L238
[G9]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/artifacts/index.ts#L31-L175
[G10]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/apps/tui/src/extensions/builtins/artifacts.client.ts#L30-L58
[G11]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/artifacts-protocol.ts#L80-L148
[G12]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/runtime/code-cell/cell-kernel.ts#L71-L255
[G13]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/extensions/src/fs-tools/write.ts#L43-L76
[G14]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/domain/extension-services.ts#L360-L365
[G15]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/runtime/code-cell/cell-tool-host.ts#L91-L143
[G16]: https://github.com/cevr/gent/blob/4e885c4b9731cd01f734ab8086788d717573155a/packages/core/src/server/session-mutations-live.ts#L283-L344
[D1]: /Users/cvr/Developer/personal/gent/plans/kernel-backed-artifacts-and-simplification.md:65
[P1]: https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/prompts/rlm.ts#L14-L198
[P2]: https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/kernel/state-snapshot.ts#L1-L131
[P3]: https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/rlm-runtime.ts#L151-L241
[P4]: https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/agent-session.ts#L9170-L9264
[P5]: https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/prime-agent-runtime/src/rlm/harness.py#L77-L299
[P6]: https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/docs/prompt-templates.md#L1-L72
[P7]: https://github.com/primeintellect-ai/prime-agent/blob/a3b3e753490d0a6ed180e905200c1a6690d78608/packages/coding-agent/src/core/session-file-actions.ts#L13-L62
[U1]: https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/packages/coding-agent/src/core/prompts/rlm.ts#L14-L223
[U2]: https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/packages/coding-agent/src/core/kernel/state-snapshot.ts#L1-L47
[U3]: https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/prime-agent-runtime/src/rlm/repl.py#L629-L783
[U4]: https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/packages/coding-agent/src/core/kernel/repl-manager.ts#L1472-L1587
[U5]: https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/packages/coding-agent/src/core/rlm-runtime.ts#L249-L320
[U6]: https://github.com/primeintellect-ai/prime-agent/blob/bf8894afa55832f7cfa2094c8a0d041bc680a691/prime-agent-runtime/src/rlm/harness.py#L80-L318
[R1]: https://arxiv.org/html/2512.24601v2#S2
[C1]: https://developers.cloudflare.com/agents/tools/codemode/
[C2]: https://developers.cloudflare.com/agents/tools/codemode/how-it-works/
[C3]: https://github.com/cloudflare/agents/blob/main/packages/codemode/README.md#network-isolation
