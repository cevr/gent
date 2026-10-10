# Handoff: tracks, gent as the orchestration harness (2026-10-10)

Written by Claude at the end of the dotfiles session `9dad17b6-dc2f-457b-9042-5ad4ee9553a8`, which built baton, ran the loop retro and drafted the tracks plan. Read this instead of that thread. The design is [tracks-extension.md](tracks-extension.md); this file says where things stand and what to do first.

## Where things are

| Item          | Value                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| gent `main`   | `7c2691307`, the same on the laptop and the workbox                                    |
| `origin/main` | 6 commits behind: nothing from this session is pushed                                  |
| Gate          | green on the workbox at `7c2691307` (`/tmp/gent-gate-7c2691307.log` there)             |
| Laptop gate   | 3 TUI tests fail on `main` too, so the laptop alone: see Known issues                  |
| baton         | `~/Developer/personal/dotfiles/baton`, on `PATH` as `baton`; it still drives every run |
| Rifts         | none open for this work                                                                |

Feature work goes in a Rift (`rift create --name <name> --copy-all ~/Developer/personal/gent` on the laptop, `workrift create <branch>` on the workbox), not in the warm source.

## The goal

The owner's loops (`~/.claude/skills/orchestrate`, `~/.claude/skills/architecture-loop`) run today as tracks through baton: an event log in SQLite, folded into who holds the baton and what each agent is owed, delivered to herdr panes (Claude Code implements, Codex reviews). gent becomes their home: a `@gent/tracks` extension holds the same log and fold, and its seats are child sessions. Routing becomes code: verdicts, failure caps, the gate queue, cleanup, delivery. The models keep the judgment: specs, reviews, merges, re-plans. baton runs until each stage replaces a piece of it.

## Owner decisions (2026-10-10)

- gent is the owner's: its limits, such as the child cache lifetime, are ours to change rather than constraints to work around.
- The release is deferred. Do not tag or publish. The orchestrator runs a `dev-<hash>` build of a merged `main` with its own `GENT_DATA_DIR` (plan, G8).
- Safety is handled by Claude Code's classifier. Build no command guards beyond the hook-bypass refusal that already exists in the orchestrate mod.
- Push: `NORTH_STAR.md`'s `Push:` owner rule (main after a loop pass's batches merge green). Outside a loop pass, ask.

## Done this session

| Commit      | What                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `589bf4776` | The 2026-09-24 push grant is an owner rule in `NORTH_STAR.md`                                                                                                                                                                                                                                                                                                                                                       |
| `7b9a8b1ef` | `apps/site` pins the published `alchemy@2.0.0-beta.81` and `@distilled.cloud/*@1.0.0-rc.13`; the `pkg.alchemy.run` preview tarballs had started returning 404                                                                                                                                                                                                                                                       |
| `cc831e847` | The counsel recipe names `overrides.model`; `delegate.start` refuses `modelId`                                                                                                                                                                                                                                                                                                                                      |
| `56e2b2df4` | The tracks plan                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ca5e999d4` | **G1 and G2.** `AgentDefinition.promptCache: "child" \| "session"`. The turn splits `spawned` (never routed, keeps its effort) from `child` (the cache class). Tests: `model-context.test.ts` "a child whose agent keeps the session cache keeps the root lifetime", `turn.test.ts` "a spawned child session on the session cache never asks the effort router". The owner rule on child caches names the exception |
| `7c2691307` | The plan records G1, G2, the reviewer catalog check and the deferred release                                                                                                                                                                                                                                                                                                                                        |

G3's catalog check is done: models.dev lists `gpt-6.1-sol` with efforts `low` to `max`, it passes `isOpenAIOAuthModel`, and `openai.test.ts` resolves it with OAuth info. No live call was made, since a check may not call a paid model. A live seat turn is part of stage 1's acceptance.

## Next: stage 1, one track end to end

From the plan's Stages. Build in a Rift on a branch such as `feat/tracks-stage-1`.

1. **Read first:** the plan in full; baton's `src/domain/event.ts`, `state.ts` and `decide.ts` (the code to lift) and `tests/domain.test.ts` (the tests to port); `~/.claude/skills/orchestrate/protocol.md` (what seats do); `ARCHITECTURE.md` on extension-owned tables and `ExtensionContext.Session`.
2. **`packages/extensions/src/tracks.ts`**, one file with section banners: the event schemas, then the fold and decide lifted from baton with the three edits the plan names (`Agent{name, pane}` becomes `Seat{sessionId, branchId, model, effort}`; `seatOf` matches the calling session; the herdr parts go). Then the `track_events` table, created by a process Resource. Each command is one transaction: read, decide, append.
3. **Seats:** register `track-impl` and `track-rev` agents with `promptCache: "session"` and an addendum that sends the seat to `protocol.md` and `safety.md`. Create them with `ctx.Session.create(... requestId: "tracks:<run>:<unit>:<role>")`, not `delegate.start`. Refuse an implementor and reviewer from the same provider family.
4. **Tools:** `track.open`, `track.pass`, `track.ask`, `track.tell`, `track.close`, `track.status`. Delivery is `ctx.Session.send({ delivery: "queue", sourceId: "tracks:<run>:<ref>", wake: true })`, then `MessageDelivered`. A reconcile on `loopOpen` sends again whatever is still owed.
5. **Seat hook** on `turnAfter`: record `SeatTurnEnded`. A holder whose turn ended without a pass gets one nudge, and a second ends as `StallDetected{unpassed}`.
6. **Opt-in**, as `@gent/guard` is: nothing registers until a config file names `tracks`.

**Done when:**

- the fold and decide tests (ported from baton) and one `createRpcHarness` acceptance (open, then changes, then accepted, on `LanguageModelLayers.sequence`) pass;
- one real small unit runs open → at least 2 rounds → accepted → merged by hand → closed, with every step in `track_events`;
- a server restart mid-round loses no message;
- for the first two units, a Codex pane under baton reviews the same rounds as a shadow (risk R1). Keep gent's reviewer when it finds at least the Blockers and Majors that Codex finds.

Stage 2 (G4 to G7: integrate, the gate semaphore, the compaction cause, stopping a session's jobs) follows from the plan.

## Open owner question

R6: ship tracks inside gent (opt-in, like guard) or as a user extension. The plan recommends shipping it, because it needs the extension-owned Tags of `@gent/workspaces` and `@gent/exec-tools`. Proceed on that unless the owner says otherwise.

## Known issues

- **Laptop-only TUI failures**, on `main` as well: "client extension reload > a save to a module the first build finds…", "source run preload > a child with a home of its own…", "gent upgrade > moves an install to the latest release…". The workbox passes all three. Not yet diagnosed.
- **A fragile TUI test:** "the prompt search overdraws nothing from 10 rows down to 5" (`apps/tui/tests/app.test.tsx`, `shortPanes`) rejects any row with the word `prompt` that is not a search entry. The status row shows the branch name, so a branch named `*prompt*` fails it. Fix the predicate to look only at pane rows, or avoid such names.
- **The orchestrator's build:** gent is also what the loops change. Until a release exists, upgrade the orchestrator's dev build only between runs.

## Start a new session with

> Read `plans/handoff-2026-10-10-tracks.md` and `plans/tracks-extension.md`, then start stage 1 of the tracks extension in a Rift.
