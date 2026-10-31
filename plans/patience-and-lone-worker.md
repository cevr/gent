# Patience and the lone worker (queue row 39)

Status: commit 1 (core admission) built 2026-10-31; commit 2 (machine
patience) follows.

## What the owner asked

From the dotfiles dream of 2026-10-30 ([kernel-orchestration.md](kernel-orchestration.md),
learnings 13 and 14):

- A round queued over 10 minutes, or whose grant names an opening over 10
  minutes away, moves to the next model of the other family.
- A run with no running round always starts one, unless the model is spent.
- A user's own turn does not block a worker's start.

## What exists (measured, main c36886148)

- Admission (`CredentialPlacement.admitLane`, `laneCheck`,
  packages/core/src/runtime/provider.ts) counts as load every open turn on
  the scope's accounts (`running`) and every live grant (`reserved`),
  through `lanesHeld`; only the asker's own open turn is left out. An
  owner's interactive turn opens a lane (`openLane`) with no grant, so it
  counts, and a worker's start can queue behind it.
- A start whose size does not fit beside the load waits in the fair queue
  (`Queued`); one that does not fit even with no load is refused for good
  (`LaneUnavailable`, `spent`). The pace alone can make that refusal: a
  window at its 5h share, or a pace under one run's share, carries no run
  though no window is rejected.
- A role pick (`freeModel`, packages/extensions/src/machines.ts) admits
  each choice in order and takes the first `Admitted`; with none admitted,
  it queues on the first choice that was not refused and waits there with
  no limit. A choice that is refused (spent) is skipped at once, so the
  "grant names an opening over 10 minutes away" case is already a skip: a
  refusal names its `retryAt`, and the pick moves past it.
- `LaneAdmission.Queued` names only `ahead`; the queue keeps no ETA.

## Design

1. **Owner turns are not load.** An open turn counts toward admission only
   when a start was admitted to it (a grant opened it, or a restart resumed
   an admitted turn: `OpenLane.resumed`). The owner's own turns still spend
   fuel, and the pace reads that from the live quota readings, so the
   capacity falls as the owner works; they never take a worker's place.
   The lanes report's `load` counts the same runs.
2. **The lone start.** A start that does not fit even with no load is
   admitted when the scope runs no admitted run of the provider (load 0)
   and an account of the scope can serve the model now: not held by a
   refusal and with no rejected window for it (`isHeld`). The pace limits
   how many runs go at once, never whether one goes. Spent (every account
   held, or the Sabbath) is still a refusal.
3. **Patience** (commit 2). A round that its pick left queued records when
   it queued and on which model (`Round.queuedOn`, `Round.queuedAt`). Ten
   minutes on, if the round's lane is still queued (a read-only
   `Accounts.waiting(key)` answers), the machine frees the queued start and
   picks again with every choice of that model's maker left out; the
   round's new thread starts on the next choice of another maker, queued or
   admitted. With no such choice, it keeps its place. A pick that moved
   records a `Waiting`-like step (`patience`), so the status shows why.

## Decided questions

- "Lone" is per pool (provider and scope), not per run: one run per machine
  run would let many runs each start one and defeat the pace.
- The other family is the other maker (`Accounts.maker`), as `against`
  reads it.
- The 10 minutes is a constant (`PATIENCE`), not config: one owner, one
  value.

## Commits (planned)

1. core: owner turns are not load; the lone start. Tests in
   core/tests/runtime/provider.test.ts (account lanes): a start beside an
   owner's open turn is admitted where the turn would have filled the
   pool, and a start that joins an owner's turn makes it a run; a start
   the pace alone refuses is admitted when nothing runs, and refused when
   every account is held. The turn record keeps `lane` (`TurnLane`, kernel
   schema 6) in place of `laneSabbath`. lanes.md updated.
2. machines: patience, with `Accounts.waiting`.
