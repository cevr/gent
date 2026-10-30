# Roles and models (queue row 38)

Status: design, not built. Written 2026-10-30 before the Sabbath; review it
before the first commit.

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
  holds two ordered `ModelId` lists. `strongest` takes the first model with a
  free lane. `efficient` ranks by cost per accepted unit (`efficientOrder`,
  machines.ts:2629).
- `tierPick` (machines.ts:2763) walks the order. With no model free it waits
  in the queue of the first model that is not spent, and never runs the other
  tier.
- The owner's `~/.gent/config.json` has no `tiers` (measured earlier this
  session).
- Model ids name their family as a token: `gpt-6.1-sol`, `gpt-5.6-luna`,
  `claude-opus-5-5`. The provider's `-latest` alias exists only for some
  providers (`LATEST_ALIAS`, provider.ts:7098).

## Design

1. **Config `roles` replaces `tiers`.** `roles` maps a role name to an ordered
   list of choices. A choice is `{ family, provider, effort, when? }`:
   - `family` is a family token (`opus`, `luna`, `sol`). It resolves to the
     newest release of that provider whose model id holds the token, by the
     catalog's release date. A pinned `model` id stays allowed for a test,
     but the owner's file names families.
   - `when` names a flag of the run's input (`codemod`, `deep`,
     `interactive`). A choice with `when` applies only when that flag is
     true. A choice without one always applies.
   - `effortFirstVisit` (optional) overrides `effort` on the role's first
     visit, for "max only on a deep unit's round 1".
     `tiers` goes: no shim (personal library). The `efficient` cost rank becomes
     an option of a role, `rank: "cheapest"`, kept because it is a gent-owned
     feature.
2. **`ThreadRole.role`** names a config role and replaces `tier`. A `model`
   still wins over it.
3. **Other family.** A role may name `against: <role>`. Its pick drops every
   choice whose provider is the provider of the model that role's thread last
   ran in this run. With none left, the round waits with a reason that says
   so; it never runs the same family.
4. **Pick.** As `tierPick` does today: the first applicable choice with a free
   lane. With none free, the round waits in the queue of the first that is not
   spent. Row 39 (patience) later moves a long wait to the next choice of the
   other family.
5. **Owner config.** Add `roles` to `~/.gent/config.json` with the four roles
   above (luna, not Sonnet). That is an edit to the owner's file: the owner
   applies it, or approves it first.

## Open questions (decide from principles before building)

- Family resolution: by id token over the catalog (above), or a declared
  family? Facts: a catalog `Model` has `releaseDate` (`domain/agent.ts:128`,
  ordered at `:249`); the gent parser reads no models.dev family field; the
  Anthropic driver keeps its own family table (`anthropic.ts:3522`). One
  family rule for every driver, owned by core, beats a table per driver.
- `when` flags: one input key per flag, or a `unit` input with kinds? Prefer
  what the shipped machines already pass.
- Where the role lists live for a project: shadow the user's list by role, as
  `tiers` did list by list.

## Commits (planned)

1. core: `roles` in config, family resolution, with tests; `tiers` removed.
2. machines: `ThreadRole.role`, the pick over choices, `against`, waits.
3. shipped machines and docs move from `tier` to `role`; the owner's config.
