# Architecture loop, fourth run: fewer concepts (2026-09-22 →)

Goal, verbatim from the session: "reduce concepts and code and files (use
single files as much as possible) without removing featureset unless the
features add no value. look to opencode (effect native and codemode), pi
(pico branch - minimal core) and prime-agent (RLM kernel) prior arts to
compare against. see how we can improve across these different
architectures. look at each package in the monorepo. the north stars are
effect-native, actor-model, lean core with maximal expressiveness via
plugins/extensions".

The third run (`architecture-loop-2026-09-18.md`) folded files to one per
concern. This run targets concepts: names an extension author or core
maintainer must learn, and core concepts an extension could own.

Work happens on the rift `arch-loop-4`.

## Baseline (HEAD `5d50b4dd`)

| Package    | Source lines | Source files |
| ---------- | ------------ | ------------ |
| core       | 26,628       | 33           |
| extensions | 17,313       | 27           |
| tui        | 23,403       | 30           |
| sdk        | 2,048        | 6            |
| tooling    | 3,661        | 4            |
| e2e        | 449          | 3            |
| server     | 59           | 1            |

Loop (`runtime/agent-loop.ts`, `runtime/turn.ts`, `runtime/tools.ts`,
`domain/agent-loop.ts`): 7,675 lines. Test files: 115.

Prior art, refreshed 2026-09-22: opencode `v2` at `5c53cfc342`, pi `pico` at
`9672462`, prime-agent `main` at `9fb6cde`.

## Coverage

Every source directory was swept by an earlier run. Pass 1 sweeps all six
areas again with the concept lens: core runtime, core domain/storage/server,
extensions, tui, sdk/tooling/e2e/server, and a cross-cutting prior-art
concept inventory.

## Pass 1 triage

Reports (session scratchpad): `pass1-core-runtime.md`, `pass1-core-domain.md`,
`pass1-extensions.md`, `pass1-tui.md`, `pass1-sdk-tooling.md`,
`pass1-prior-art.md`.

Headline from the prior-art inventory: gent already has the smallest hook
surface (3 kinds against pico3's 8, prime's 27, opencode's 15+), zero tools in
core, and children, compaction and scheduling as extensions. The weight is in
optional fields with no shipped user, second paths for one job, and the TUI's
extension surface (about 30 names, 5 Tags, 3 command stores).

### Batch A — core (rift `arch-loop-4`)

| #   | Finding                                                           | Source              |
| --- | ----------------------------------------------------------------- | ------------------- |
| A1  | Static `prompt` section on tool/request: 0 shipped users          | domain C1, pa C2    |
| A2  | `ToolPolicyFragment.exclude/overrideSet`: 0 shipped users         | domain C8, pa C3    |
| A3  | Resource `tag/start/stop`: tag unread, stop unused, start 1 user  | domain C3/C4, pa C4 |
| A4  | `hook`/`AnyExtensionHook` public, `host.source`, `getLatestEvent` | domain C2/C6/C7     |
| A5  | `DriverRegistry` second owner of drivers; dup `extensionHooks`    | runtime R1-R3       |
| A6  | Host context provider pass-through; `RuntimeEnvironment` overlap  | runtime R6/R7/R9    |
| A7  | `wide-event-boundary.ts` shallow module                           | runtime R4          |
| A8  | Delegate is the only `Interrupt` writer; switch to `Cancel`       | domain C11, pa C1   |
| A9  | Children may inherit the parent thread id (possible bug)          | runtime note        |
| A10 | Comment and ARCHITECTURE drift                                    | H1, C9, pa notes    |

### Batch T — tui (rift `arch-loop-4-tui`)

C1 command stores, C2 dead commands + `/driver` model-turn defect, C3 unread
UI members, C4 collision wipes every client extension, C5 headless registry,
C6 session query helper, C8 btw docked, C9 sessions → agents pane, C10/C11,
C13 loader resolver, C14 dead props, C15 comments. Deferred: C7 (one
ClientContext Tag), C12, C16, C17, C18.

### Batch E — extensions (after A merges)

C1 anthropic via Effect `Crypto` (removes the last shipped core-internal
import and two guard exemptions), C2 `monitor` readonly + no bash guardrail
(bug), C3 agents view labels every loop `main` (bug), C4 index re-exports,
C5 contradictory guidance, C8 drop `read_session` goal (the only blocking
child path; owner rule "children wake, never block"), C9 handoff folds into
workflows + interaction-tools, C10 anthropic `source` param, C11 models-dev
folds into providers, C12 one cell storage Tag, C6 OpenAI chat fallback
(deletion test), H comments.

### Batch S — sdk/tooling/root (after T merges)

S1 one retired-names table, S2 SDK `extract*` wrappers, S3 fold
namespaced-client, S4 two e2e files, S5 server-lock interface, S6 dead root
files (`scripts/fix-imports.ts`, `.husky/`, `PLAN.md`, bunfig/turbo lines),
S7 `createToolTestLayer` third root, W5 78 unused suppressions, W6 two guards
fail deletion test, W7 identity-encode guard blind + untested, W8 root edges,
W2 stale `--debug` seed, CI Bun version drift.

### Pass 2 candidates (design first)

- One delivery verb: `Session.send` with `delivery: steer | followUp`
  (pa C6, domain C14) — opencode and pico3 both have one verb.
- Typed tool namespace in the cell, `tools.delegate.start(...)`, with a
  rendered signature line; drop `tools.search` (pa C8, ext C14).
- Background bash as a one-shot wake job (ext C7): one owner for "run a
  command, wake with its outcome".
- Message-row renderer keyed by `customType` (pa C7).
- `Files`/`Process.run` facets vs raw platform services (pa C9).
- One `ClientContext` Tag (tui C7).
- Delete `@gent/core-internal` (sdk W3).

### Rejected this pass

| Candidate                                                             | Why                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Delete `Interrupt` from `SteerCommand`                                | Steer is a persisted mailbox op; stored rows must decode. Writer removed instead (A8).                                |
| Stop writing `SessionStarted`/`BranchCreated`                         | Variants must stay for old rows; saves ~15 lines, no concept removed                                                  |
| `StreamEnded.interrupted`                                             | Persisted field, 2 lines                                                                                              |
| Resume legacy probe (R13)                                             | Persisted: pre-TurnRecord turns can exist on disk                                                                     |
| Fold the cell trio into one file                                      | Process entry + shared wire module                                                                                    |
| Hook kinds merge; tool vs request merge                               | Already the smallest surface of all four harnesses                                                                    |
| Fork-as-session (delete Branch), replay flag, agent registry collapse | Persisted formats with very high blast radius; owner decision                                                         |
| Host-owned extension state (pa C12), `write` delivery (pa C13)        | Persisted format change; revisit after the delivery verb                                                              |
| Delete `@gent/handoff` (pa C10)                                       | Removes "continue in a new session"; memory keeps `/handoff` as the explicit new-session action. Fold instead (E C9). |

### Pass 1 results (merged to main at `708d365a` and `6efcd691`)

`git diff --stat 5d50b4dd..6efcd691`: 117 files, +4,820 / −6,843 (net −2,023),
source files 109 → 106 (`wide-event-boundary.ts`, `handoff.ts`,
`models-dev.ts`). Gate green on main; gamut `sonnet-sonnet` on main: six
delegate children, completions reached the parent, red app `17 pass, 0 fail`.

| #   | Status                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | done `64a4f843`                                                                                                                                                                                                                                                      |
| A2  | done `80a6f8d8`                                                                                                                                                                                                                                                      |
| A3  | done `8bd4d9ba` (exec-tools reconcile runs in its layer; a process-resource failure still rejects its extension)                                                                                                                                                     |
| A4  | done `a818c027`; the session-tools naming line stays on `systemPrompt` (moving it would put it before the cell's Host Tools catalog)                                                                                                                                 |
| A5  | done `887c6aa6`                                                                                                                                                                                                                                                      |
| A6  | done `0ef9ffcb`; R5 (one turn-profile path) skipped: ~38 actor test roots have no profile cache, so it adds wiring rather than deleting it                                                                                                                           |
| A7  | done `15972830`                                                                                                                                                                                                                                                      |
| A8  | done `e4195480`; `Interrupt` is decode-only                                                                                                                                                                                                                          |
| A9  | done `bded8dce` (children started in the parent thread; red first); review P1: `/handoff` then lost its thread, fixed `d1024792` (`continueThread` on `session.create`, set only by the TUI handoff)                                                                 |
| A10 | done `a289d998`, review P3 (branch resource failure fails its loop) in `d1024792`                                                                                                                                                                                    |
| T   | done `b82915cd` … `575d45a7` (11 commits); review fixes `71d30505` (notices got their own footer channel instead of `setError`; collisions decided before any transfer; btw takes paste). C9 skipped: the palette's side-thread mark needs `threadId` on agents rows |
| E   | done `bae12d8d` … `9a5f0579` (12 commits); review fixes `17617db9` (stored risky monitors need a clearance mark on re-arm; stored private children are dropped, never delivered; handoff renderer moved under `@gent/interaction-tools`)                             |
| S   | in progress on `arch-loop-4-sdk`                                                                                                                                                                                                                                     |

Receipts on the way: the `@gent/core-internal` guard for shipped extensions
now has zero exceptions (`bae12d8d`). Live run found a gap, not a
regression: `read_session` cannot find the caller's own session id.

### Pass 2 results

| Candidate                                                               | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery verb                                                           | done `29e75d69`, merged `6c5c4454`: `Session.send` takes `delivery: "turn" \| "queue" \| "steer"`, `Session.stop` writes `Cancel`; facade verbs `steer` and `queueFollowUp` gone. Review P2 (no input decode) fixed `da6ba1f1`, red first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| sdk/tooling (S)                                                         | done `02ab1d0f` … `d37cb946` (12 commits), merged `9e63c0f0`: 64 files, +1,539 / −2,611. Review P2s (identity guard skipped a line on any `[`; hook guard accepted a comment) fixed `8f7e0718`, red first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Message rows + ClientContext                                            | done `b7bde7e6`, `5ee160bc`, merged `e42bd6ec`: extension clients render goal, wake and session-message rows by `customType`; five client Tags → one `ClientContext`. Review P2 (native history committed rows before client extensions loaded) fixed `624d7eb9`; the test that raced the load under `--parallel` fixed `a7d5ba0a`. Gamut `sonnet-sonnet`: six children, red app `19 pass, 0 fail`, wake row rendered live and after restart                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Cell namespace                                                          | done `2f8880e2`, merged `c45cc305`: `tools.delegate.start(...)` paths with signature lines; `tools.call` and `tools.search` gone; replay keys unchanged. Review P2s (probe keys, `null` input, `describe` shadowing, optional marks, prompt size) fixed `3df1cc0c`. Found on the way: source runs used a stale 8 Sept worker from `packages/core/dist/gent-cell` — the cell now owns its worker launch and `siblingBinaryPath` is gone (`9af618a1`); source workers skip project `bunfig.toml` and `.env` (`613ba441`); a cell starts in its session's directory, not the host's (`e95ea3b3`). Net +903 lines: a capability, not a reduction                                                                                                                                                                                                                                             |
| gamut wait                                                              | `e03caae1`: `wait` also requires no open turn in the run's `data.db`; it returned while children worked because the agents tray was off screen. Live: held 3 min 49 s until all six completions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Background bash as a wake job                                           | owner decision: adds a persisted `WakeEntry` tag and abandons `background_bash_jobs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Files`/`Process` facets                                                | done `c396dc59`, guard `f7b905d7`, merged `aca54a47`: 35 files, +440 / −751. `ExtensionContext.Files`/`.Process`, `ExtensionHost.Process`, `GentPlatform.env`, core `makeFileWriter` gone; extensions yield `FileSystem`, `Path`, `ChildProcessSpawner`, `Crypto`; `writeFileAtomic` has one owner in `fs-tools.ts`; relative paths resolve against the session cwd. Counsel clean. Live: six children, red app `19 pass, 0 fail`; a wake monitor fired when its flag file appeared                                                                                                                                                                                                                                                                                                                                                                                                      |
| Delete `@gent/core-internal` (W3) + one enforcement point per rule (W4) | done `f5e2a56f`, `8af1f5db`, merged `bea0f5e5`: 128 files, +2,414 / −2,480, one package gone. Core has two explicit entries beside `protocol` and `extensions/api`: `@gent/core/host` (product callers only, guarded) and `@gent/core/test-utils` (harness operations; a short list of core services tests compose). One oxlint rule, `gent/core-entry-boundary`, replaces the core-internal guard rows and rule, and resolves relative paths. W4: `withX` style, extension imports and host facts each have one oxlint rule; planted violations proved every behavior the deleted guards caught. Review (2 P2, 2 P3) fixed `1e1d83f5` … `eef1c62d`: relative imports resolved; `Effect.fn` wrappers seen; core-behavior tests moved into core; test-only names left `host`. Live: headless `-H` and `sessions`, gamut seven children, red app `19 pass, 0 fail`, `/thread` pane renders |

## Pass 3 (sweep of main at `33c20eb8`)

Four read-only sweeps, one per package group. Reports: TUI 11 findings, core 25, extensions 32 (X tools, P providers), sdk/tooling/root 16. The pass found real defects, so it is not polish-only.

### Pass 3 triage

| Batch                  | Rift               | Findings                                                                                                                                                               |
| ---------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C9 (pass 2 carry)      | `sessions-pane`    | agents pane is the one session browser                                                                                                                                 |
| TUI F1                 | `interaction-load` | pending interaction auto-denied before client extensions load                                                                                                          |
| Core                   | `p3-core`          | bugs P8, P9, P5, P1; P2 if no persisted change; reductions P3, P4, P6, P7                                                                                              |
| Extension tools        | `p3-ext`           | bugs X1 (bash cwd), X3 (grep glob), X4 (monitor timeout); X2 cell deadline vs prompt; X6–X13 where confirmed. X14 parked (background bash owner decision)              |
| Providers              | `p3-providers`     | bugs P1, P3–P7, P2; P9 double retry; P13 dead ACP permission handler; P8, P10–P17 where confirmed                                                                      |
| sdk/tooling/root       | `p3-tooling`       | bugs F2 (two fingerprints), F3 (dbPath attach); F1 core→SDK cycle; F4+X5 examples gate; F5 lint plugin typecheck; F7, F8; F6 docs. F11 (W1 shared mode) owner decision |
| TUI rest (after above) | —                  | F2 delegate child tree to a `delegate.client` extension; F3 border-label positions; F5 connection widget; F4 one pane owner; F10 wake tray pulses                      |

### Pass 3 results

| Candidate       | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C9              | done `259971af`, merged `421bc683`: `/sessions`, `/agents`, `/tree` and the palette "Sessions" item open the agents pane; `sideThread` row projection (no stored change); `sessionsLevel`, `buildSessionTree`, `session.sessions`, client `listSessions` gone; 11 files, +315 / −379. Review P2 (a child with only `parentSessionId` lost the mark) fixed `e6d5bcf7`, red first. Live: gamut `sonnet-sonnet`, six side-thread children before and after `gamut restart`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| TUI F1          | done `c5b951f1`, merged `ccd02717`: the composer waits on `ext.loaded()`; the host draws an unmatched interaction with `PromptRenderer`; the `undefined` default key, `CancelInteraction` and its reducer arm gone. Red first; probes: original code and a dropped load gate both go red. Review P1 (a hung extension hides the interaction for good) fixed `070c5fef`: each import and setup has a 10 s bound, and a timeout is a load failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Extension tools | done `3fe03ace`, `af91fd20`, `eb7bf98e`, merged `2b0d1a90`: bash and monitor run in the session directory (X1); a slash-free grep glob matches nested files (X3); a monitor check stops at its deadline (X4); the cell prompt names its 30 s deadline and sends builds and tests to bash (X2); delegate and session-tools own their prompt sections (X13); `handoff` only on request (X12); summary search is one pass (X10); turn-time delegate reconcile runs once per branch per process (X8). Review (4 P2: slash globs, a failed child delivery stayed undelivered, stored relative monitor cwd, a cut check matched `until`) fixed `a503149a`, red first. Open for the owner: X7 (state files and `GENT_DATA_DIR`), X6 in full (one transcript reader), X9 (`/btw` follower)                                                                                                                                                                                                                                                                                                                                                                                   |
| Core            | done `15f850f7` … `d47499d0`, merged `18ffe6c2`: a caller fails only on its own turn's failure (P8); an interrupt of a parked interaction gives the call a result (P9); an import failure reaches extension health (P5); `model.list`/`driver.*` read the caller's session registry (P1); usage totals are complete or absent (P2); `ExternalToolRunner`, `ExtensionContext.turn`, unread parked fields, `ServerRootPlatformLayer` and `ToolRunner.run` gone; last budgeted step writes no continuation (W8). Review (P1: a queued turn that failed before settle held the queue; P2: interrupted cold recovery wrote over stored results; P2: unknown usage dropped known charges) fixed `e1dbf970`, `82fe35e1`: `turnAfter` gets `usage: { known, complete }`; a budgeted goal pauses with a visible reason when usage is incomplete (`GoalState.pausedReason`, additive). Semantic conflict with the tools batch (`ctx.turn` removed) fixed on main `5a218a51`. Found: a batched follow-up's waiter returns before its content runs → rift `p3-followup`                                                                                                          |
| TUI rest        | done `b001de64` … `6a5954f2`, merged `4581f199`: delegate child tree is the `delegate.client` extension with a `sessionEvents` transport verb, and a lint rule keeps `@gent/extensions` out of core TUI files (F2); one status row, no label positions (F3); connection widget is host chrome (F5); one pane slot owned by the session view, `shell.pane.open/close/isOpen` (F4); extension cleanups run at shutdown. Review P2 (an old `borderLabels` key dropped labels silently) fixed `0cc53e06`: an unknown contribution key fails the extension by name. Owner: a cell draws each op through its registered tool renderer (`48d4ec44`); a guard test fails on a renderer name that is no tool id; `MODEL_CHANGE_MESSAGE_TYPE` exported (`4b0935f8`). Live: the first cell-op build froze the TUI (expanded `read` ops, nested frame headers hidden); ops now draw collapsed and nested frames keep their header; six children drew under the cell row in the transcript view. Pass 4 candidates: the tree under a cell stays empty in native scrollback (rows commit before children run); cell receipts carry no op ids, so a reload shows receipt lines only |
| Providers       | done `bde01e6e` … `69dc354c`, merged `f1c0e778`: credential refresh has a 15 s timeout (P3); an abandoned OpenAI login is dropped after 5 min (P4); a failed redirect server fails the login (P5); the Anthropic refresh keeps its cause (P6); core is the one retry owner for 429/5xx/transport (P9); one `postOAuthForm` (P10); the OAuth error page escapes its text (P17). Review P2 (every refresh failure stopped retrying) fixed `6374bc9e`: temporary outages stay retryable, a rejected token stops the turn. Owner decisions: ACP removed with the core external-driver seam (`0ff258cf`, `74207789`, −5,700 lines); a stored `External` driver ref loads as no override and warns once; the keychain token is tried first (P15); a revoked sign-in shows only `ChatGPT sign-in expired: … Sign in again with /auth.` (`2fd6d745`, `2b0a304c`; credential failure travels as `AiError` metadata; `causeMessage` reads class-defined messages). Merge with core resolved in the rift (`c886577c`). Open: no end-to-end Anthropic revocation test (needs a stub `claude`)                                                                                    |
