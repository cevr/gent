# Architecture history

An archive of the owner directions, measurements and pass evidence behind the
architecture files. No brief reads it by default; the live rules are in
`ARCHITECTURE.md` and the area files beside this one.

## Owner directions

- **Cold-cache handoff (Pass 30)**, behind `coldHandoffPays` in
  `rules.md` rule 17: "for the auto-compaction, we should probably only
  autocompact after a certain treshold - how many tokens we would be sending
  to refresh the cache for example. something like if its over 150k tokens
  or something its better to compact, or measure against the amount of
  tokens the handoff would generate as well".
- **Virtual models (Pass 30)**, behind `context.md` (Virtual models): "the
  virtual router should be some sort of json, with models that have a reason
  or description".
- **Model catalog (Pass 30)**, behind `models.md` (Model catalog). It
  replaced the rule that core fetches nothing: "models.dev is integral to
  discovery of models via providers so we don't really need to hardcode
  anything, only limiting factor is classes of api's we support", and
  "snapshotting will be good so we don't constantly ping … we can put that
  in our sqlite db".
- **Typed fan-in for children (ledger A3)**, the known gap in `rules.md`:
  the owner rejected a blocking `collect` on 2026-09-18. Gamut run 34, then
  a run on the delegate (six starts in one cell, six wakes), showed each
  round end arriving as a wake.

## Measurements

- **Root layer builds.** One build of the production root (the shipped
  extensions, in-memory state) reached a leaf layer 154 times, memo hits
  included, counted on 2026-10-05 as the calls to the memo map's
  `getOrElseMemoize` (`server.md`, App Services).
- **Skills listing.** On the owner's home the listing was 6.7k characters,
  against 21.5k for the former listing that gave every skill its full
  description and absolute path. The measurement that made it the only
  listing (a $0 Codex run, two prompts, each listing once): the first
  request of every turn fell from 8,905 to 5,162 input tokens (−42%), turn
  totals from 52,956 to 32,647, and both listings found the right skill for
  both prompts (the short listing read a wrong skill first once and
  corrected itself in the same turn).
- **Suite times (Pass 28).** Wall clock on the workbox with cached builds,
  from the Pass 28 receipts in `plans/architecture-loop-2026-09-22.md`
  (runtime and extension kernel acceptance). No guard reads them: measure
  again after a change to the suite's size.

  | Command            | Measured    |
  | ------------------ | ----------- |
  | `bun run test`     | 1m23s-1m26s |
  | `bun run test:e2e` | 1m37s-1m46s |
  | `bun run gate`     | 1m23s-1m31s |

## Pass evidence

- **Live composition.** Native source-mode approval, public repair,
  direct-command cleanup, and external callback limits have focused
  validation; the full gate and terminal/server E2E passed. See
  `plans/live-composition-review.md` for the evidence and recovery limits.
