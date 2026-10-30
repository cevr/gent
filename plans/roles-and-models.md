# Roles and models (queue row 38)

Status: design, not built. Written 2026-10-30 before the Sabbath and revised
the same day after one review (a Claude agent; Codex was pace-held). The open
questions are decided below.

## What the owner asked

- A machine role names its models and efforts in order:
  - planner: Opus at high;
  - implementor: Opus at medium, or the newest luna at max for a codemod unit;
  - reviewer: the other family at medium, max only on a deep unit's round 1;
  - verifier: luna at medium, Opus for an interactive check.
- Luna replaces Sonnet everywhere (owner, 2026-10-30).
- The reviewer never runs the implementor's model family.
- The owner's config gets the roles.
- Models go by role and are always the newest release, never a pinned
  version (owner's global rules).

## What exists (measured, main 7f5dead82)

- `ThreadRole` in `packages/extensions/src/machines.ts:151` takes `model`,
  `tier` (`strongest` | `efficient`) and `effort`. A `model` wins over a
  `tier`.
- Config `tiers` (`ModelTiersConfig`, `packages/core/src/runtime/config.ts:164`)
  holds two ordered `ModelId` lists. `strongest` tries the role's kept thread's
  model first (it keeps the cache, machines.ts:2788-2796), then the first model
  with a free lane. `efficient` ranks by cost per accepted unit
  (`efficientOrder`, machines.ts:2629).
- `tierPick` (machines.ts:2763) walks the order. With no model free it waits
  in the queue of the first model that is not spent, and never runs the other
  tier.
- A thread's spec (effort among it) goes only to `threads.start`. A kept
  thread keeps its first effort; the keep rule compares the model only
  (machines.ts:2788-2798).
- `PendingAction.Round.model` records the model each round's thread ran.
- The owner's `~/.gent/config.json` has no `tiers`; its keys are `permissions`
  and `sabbath`.
- models.dev gives a `family` on every model of every provider: `claude-opus`,
  `gpt-sol`, `gpt-luna`. One provider serves more than one maker: `opencode`
  serves `claude-opus-5-5`, `gpt-6-sol` and `gpt-6-luna`. The gent parser
  (`parseCatalogModel`, provider.ts:1839-1879) skips the field.
- A catalog `Model` has `releaseDate` (`domain/agent.ts:128`, ordered at
  `:249`). Two entries can share a date: `claude-opus-4-5` and
  `claude-opus-4-5-20251101` both have 2025-11-24.
- Two other family rules exist: the Anthropic driver reads a family from the
  id by a regex (`anthropic.ts:3508`) for its default-effort table
  (`MARKER_DEFAULT_EFFORTS`, `:3521`), and gamut keeps `FAMILIES`, a regex by
  version (`testbeds/gamut/gamut.ts:93`) that leaves out dated snapshots and
  `-pro` variants.
- The orchestrate run's input is `{ unit, goal, dir, gate, mergeGate, domain }`
  (`workflows.ts:291`). A unit's path (`light`, `deep`) is written by the
  planner into spec.md after the run starts (`workflows.ts:140`). A mechanical
  unit already starts `ORCHESTRATE_LIGHT_MACHINE`.
- Sonnet is still named as a role choice: gamut presets `opus-sonnet` and
  `sonnet-sonnet` (`gamut.ts:125-137`), the router doc example
  (`packages/extensions/src/router.ts:39`), the delegate pairing in
  `docs/architecture/threads.md:536`, and the config examples in
  `docs/extensions.md` (lines 998, 1023, 1027, 1354).

## Design

1. **The catalog declares the family.** `parseCatalogModel` reads models.dev
   `family` into `Model.family`. A model with no family matches no family
   choice; a pinned model still runs it. The maker of a family is its first
   `-` segment (`claude-opus` → `claude`, `gpt-luna` → `gpt`). This is the one
   family rule: gamut's `FAMILIES` moves onto it, and the Anthropic driver's
   regex stays only for its effort table, which keys on the id it serves.
2. **Resolution.** A choice `{ provider, family, effort }` resolves to the
   newest model of that provider whose `family` equals the choice's family, by
   `releaseDate`. On a tie the id with no date suffix wins.
3. **Config `roles` replaces `tiers`.** `roles` maps a role name to an ordered
   list of choices, and nothing else: no conditions in config. Names the
   shipped machines use: `planner`, `implementor`, `codemod`, `reviewer`,
   `deep-reviewer`, `verifier`, `live-verifier`. `rank: "cheapest"` on a role
   keeps the `efficient` cost rank, a gent-owned feature. `tiers` goes with no
   shim (personal library). A project's role replaces the user's role of that
   name as a whole, as `config.ts:512-516` shadows today; choices never merge.
4. **The machine picks the role.** A `ThreadRole` names its model as a tagged
   union: `Pinned { model, effort? }` or `Role { role }`. No precedence rule
   is left, and a `Role` takes its effort from the choice, never from the
   thread role. A thread state may name another config role for some of its
   visits, read from recorded replies, as templates already read
   `plan.reply.*`, and following the `fresh: N` visit pattern:
   - The light machine's implementor names `codemod`.
   - The planner's reply carries `path` and `interactive`. The reviewer state
     names `deep-reviewer` on visit 1 when `path` is `deep`; the verifier
     state names `live-verifier` when `interactive` is true.
   - So "max only on a deep unit's round 1" is the `deep-reviewer` role's
     effort, and needs no `effortFirstVisit`.
5. **Keep rule.** A kept thread continues only when its model and its effort
   both match the pick; otherwise the round opens a new thread. The pick tries
   the kept thread's model first, as `strongest` does, to keep the cache.
6. **Other maker.** A thread role may name `against: <role>`. Its pick drops
   every choice whose maker is the maker of the model recorded on the round
   under review (`PendingAction.Round.model` of that role's last round). A
   machine whose `against` role resolves to fewer than two makers fails at
   start. At run time an empty set (a catalog that lost a family) is a fault
   that goes to `decide` with its reason; it never waits, because nothing can
   end that wait, and it never runs the same maker.
7. **Pick.** As `tierPick` does today: the first choice with a free lane. With
   none free, the round waits in the queue of the first that is not spent.
   Row 39 (patience) later moves a long wait to the next choice.
8. **Owner config.** Add `roles` to `~/.gent/config.json` (luna, not Sonnet):
   - planner: `anthropic` `claude-opus` high;
   - implementor: `anthropic` `claude-opus` medium;
   - codemod: `openai` `gpt-luna` max;
   - reviewer and deep-reviewer: `openai` `gpt-sol` then `anthropic`
     `claude-opus`, at medium and max, with `against: implementor` in the
     shipped machines;
   - verifier: `openai` `gpt-luna` medium; live-verifier: `anthropic`
     `claude-opus` medium.
     That is an edit to the owner's file: the owner applies it, or approves it
     first.

## Decided questions

- Family: the declared models.dev family, not a match on the id (one rule,
  owned by core; an id token cannot tell luna from sol by maker).
- Conditions: in the machine, from recorded replies; config holds named lists
  only (composition over flags, no config language to grow).
- Projects: a role shadows by name, whole.

## Commits (planned)

1. core: `Model.family` from the catalog (done first, alone, before the
   Sabbath of 2026-10-30), family resolution with the tie rule, `roles` in
   config with project shadowing; `tiers` removed. Tests.
2. machines: the tagged `ThreadRole`, per-visit role choice, the keep rule on
   model and effort, `against` by maker with its start check and its `decide`
   fault, the pick and its waits. Tests.
3. shipped machines (the planner reply's `path` and `interactive`, the light
   implementor's `codemod`) and docs move to roles; gamut `FAMILIES` onto the
   resolver; Sonnet out of the gamut presets, the router example, threads.md
   and docs/extensions.md; the owner's config.
