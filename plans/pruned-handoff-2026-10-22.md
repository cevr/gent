# Pruned handoff (2026-10-22)

Status: shipped (9978f10fb, review fix 1d24905b9); live check passed on
the Haiku gamut (see Live check).

Source: the owner's idea of 2026-10-17 ("keep the conversation and stub
tool results instead of summarizing everything"), the read-cost measurement
in `plans/context-mileage-2026-10-21.md` (Read cost, Measured on Haiku
gamut), and OptMem's age-decayed reading budget. Review:
`/tmp/counsel/gent-pruned-handoff-9f0ab70c/20261022-194927-claude-to-codex-c70180/codex.md`
(verdict: revise; five major findings, all answered below).

## Problem

A handoff today replaces the whole history before the newest user message
with one summary (`packages/extensions/src/compaction.ts`,
`compactModelContext`). The summary call:

- costs a model call with its own system prompt, so it reads no cache;
- clips its input at `COMPACTION_SUMMARY_INPUT_TOKENS` (32k), so a long
  history is only partly summarized;
- leaves the model with a 150-word bridge, and the model then re-reads the
  record with `context.read`.

Tool results are 66.7% of the message text in a Haiku gamut run and 76.7%
of the owner's stored parts (measured). Most of the history's size is
results the model already acted on.

## Design

A handoff on context pressure first tries to keep the window and stub its
old tool results. It falls back to the summary when the stubbed window does
not leave room.

1. **A prune line, not a new window.** The pruning outcome persists a
   runtime user line of its own type (`context-prune`, a
   `RuntimeUserMessageType`), appended where the loop persists a marker. Its
   details carry `stubResultsBefore: MessageId`. It opens no window:
   `messagesInCurrentWindow` is unchanged, the window head (an earlier
   handoff marker included) and its summary stay as they are. Review
   finding 2 (a second marker reusing the first one's id, an anchor on an
   earlier marker, a lost earlier summary) does not arise: the line's id
   names the branch and the cutoff, `context-prune:<branch>:<cutoff>`.
2. **The model view applies it.** `modelVisibleWindow(messages)` is
   `messagesInCurrentWindow` plus the newest prune line of the window: each
   tool-result part in a message before its cutoff becomes a stub part with
   the same call id, tool name, failure flag and provider options, and the
   result text
   `[result stubbed at a handoff: <n> characters; context.read("<callId>") pages it]`.
   A result that holds images keeps its value: `context.read` returns no
   pixels, so a stubbed image would be unrecoverable. The estimate
   (`estimateHistoryTokens`), the projection (`projectCurrentWindow`) and
   the handoff planning (`projectContextWindow`) read the model view.
   Storage is never rewritten.
3. **Inheritance keeps full payloads (finding 1).** A session created with
   `historyBranchId` copies the stored window as today, with full results,
   and remaps a copied prune line's cutoff to the copy's new id. The child
   sees the same stubs, and `context.read(callId)` in the child finds the
   full result in its own branch.
4. **A step measured before a prune line no longer measures the window,**
   as for a window marker (`measureInCurrentWindow`). The rent meter
   (`foldContextRent`) treats the line as a window start: the next call
   rewrites the prefix, and the base plus the line's item hold the rest.
5. **The seam carries trigger facts (finding 3).** `CompactionRequest`
   gains `trigger` (`Requested`, `Refused`, `Overflow`, `RoleWindow`,
   `Cold`), `targetTokens` (the message tokens the kept window must not
   pass for that trigger: the model's message budget on overflow, the role
   budget's on a role handoff, the window less half the history on a cold
   start, as the cold rule's margin) and `estimateTokens(messages)`
   (chars/4 raised by the window's measured ratio, the projection's
   estimate). The answer is a tagged union, `CompactionOutcome`:
   `Summarized { notice, modelId, usage }` and
   `Pruned { notice, stubResultsBefore }`. Only `Summarized` carries a
   receipt; the turn's summary spend reads only it.
6. **One compactor owns the policy (findings 4 and 5).** The shipped
   compactor in `packages/extensions/src/compaction.ts` builds one
   candidate: the window (`history` then `kept`) with results stubbed before
   the first message of the fifth-newest assistant step. It returns
   `Pruned` when all hold:
   - the trigger is `Overflow`, `RoleWindow` or `Cold` (an explicit
     `context.compact`, with or without instructions, and a provider
     refusal get the summary);
   - the candidate plus its line fits the target with headroom: half the
     target on `Overflow` and `RoleWindow`, so the next steps do not hand
     off again at once, and the target itself on `Cold`, which already
     holds the margin;
   - the candidate stubs at least one result.
     Otherwise it summarizes the history with the candidate's stubs applied,
     so the 32k summary input reaches further back. The cross-extension chain
     keeps its refusal contract. The notice says which results are stubbed,
     gives the cutoff id and says `context.read(callId)` pages any result.
7. **Cold handoff price.** The cold gate (`coldHandoffPays`) is unchanged:
   it decides that a handoff pays. The compactor then prefers the prune
   when the prune alone saves the margin.

## Cache

The prune line rewrites the prefix once, at a point where the handoff
rewrites it anyway (inferred). Later steps append to it, so it caches as any
window does. A stub on every step is rejected: it would rewrite the prefix
each step for a 2.4% to 5.3% gain (measured on Haiku gamut).

## Not in this unit

- A cold start that prunes when the summary does not pay (a price for the
  prune alone in `coldHandoffPays`).
- Age decay of the assistant text and tool calls (OptMem's coarser blocks).
- Rules for superseded reads and replaced failed runs, and a model
  classifier for keep or stub.
- A session search over results (devsql gather); the warm pre-lapse
  handoff.

## Tests

- Model view: a prune line stubs exactly the results before its cutoff,
  keeps image results, keeps call ids and names, and leaves stored
  messages unchanged; the newest prune line wins.
- Compactor: an `Overflow` window with large old results returns `Pruned`
  at the fifth-newest step; `Requested` and `Refused` summarize; a
  candidate over half the target summarizes the stubbed history.
- Projection: a `Pruned` outcome persists a prune line; a second prune with
  a later cutoff persists a second line; the next projection sends stubs;
  no summary receipt is recorded.
- Inheritance: a child created from a pruned branch has full payloads and a
  remapped cutoff.
- Each test fails with its protection removed (probe).

## Live check

A Haiku gamut session long enough to hand off (`roleWindow` lowered in the
run's config so the orchestrator hands off), then compare input tokens and
cache reads per step before and after the handoff.

Result (2026-10-22, Haiku gamut, `agents.main.contextLength` set in the
run's config; measured from the run's `data.db` and pane):

- At 48k (message budget about 27k), each `read` step added about 4.2k
  provider tokens. Five kept steps did not fit half the budget, so all six
  handoffs fell back to a summary (`⇣ context handoff · 11 messages
  summarized`). The fit rule held.
- At 90k (budget about 58k), a 26-file read task pruned twice: step 10
  (input 68,453 → 32,842 tokens) and step 20 (66,148 → 34,498). The pane
  drew `⇣ context pruned · older tool results stubbed` both times, and
  storage holds two `context-prune` lines. No summary call ran.
- Cache: each prune step read only the system and tools from cache (9,341)
  and wrote the rest (23,497 and 25,153). The next step read the whole
  pruned prefix (32,838 of 36,757; 34,494 of 38,647). The prefix rewrites
  once per prune, as the Cache section expected.
- The model finished all 26 reads. It noted one missed sentence after the
  read the prune followed: the prune line reads as a turn break to it
  (observed once; not a defect).
