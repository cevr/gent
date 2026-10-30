import {
  Clock,
  Context,
  DateTime,
  Effect,
  Equal,
  FileSystem,
  Function,
  Layer,
  Option,
  Order,
  Path,
  PlatformError,
  Predicate,
  Ref,
  Result,
  Schema,
  SynchronizedRef,
} from "effect"
import {
  AgentName,
  AuthoredAgentPatch,
  mergeAgentPatches,
  type StoredAgentPatch,
  type DriverRef,
  ModelId,
  DriverOverridesFromConfig,
  isRetiredDriverRef,
} from "../domain/agent.js"
import type { CredentialSlot } from "../domain/ids.js"
import { CredentialOrder } from "../domain/driver.js"
import { omitUndefined } from "../domain/guards.js"
import { canonicalJsonString } from "effect-encore"
import { writeFileAtomic } from "./gent-platform.js"

// ── runtime-environment ─────────────────────────────────────────────────────

interface RuntimeEnvironmentApi {
  readonly cwd: string
  readonly home: string
}

export class RuntimeEnvironment extends Context.Service<
  RuntimeEnvironment,
  RuntimeEnvironmentApi
>()("@gent/core/src/runtime/config/RuntimeEnvironment") {
  static Live = (config: RuntimeEnvironmentApi): Layer.Layer<RuntimeEnvironment> =>
    Layer.succeed(RuntimeEnvironment, config)
}

// ── disabled extensions ─────────────────────────────────────────────────────

/**
 * Disabled-extension reader for a caller that has no `ConfigService`.
 * Effect-based — requires FileSystem and Path from the platform.
 *
 * The TUI's extension context boundary
 * (`apps/tui/src/extensions/loader-boundary.ts`) reads the set this
 * way because it runs before any server is reachable. On the server path
 * `ConfigService` is the reader and `SessionProfileCache` passes the merged
 * set down, so the two config files are opened once.
 *
 * This module also owns where those files live; `ConfigService` builds its
 * paths from the same constants.
 */

/** The per-user and per-project directory holding gent's config file. */
export const GENT_CONFIG_DIRECTORY = ".gent"

/** The config file inside `GENT_CONFIG_DIRECTORY`. */
const GENT_CONFIG_FILENAME = "config.json"

const DisabledConfig = Schema.Struct({
  disabledExtensions: Schema.optional(Schema.Array(Schema.String)),
})

/** Read disabledExtensions from a JSON config file. Returns [] on any error. */
const readDisabledFromFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(filePath)
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(DisabledConfig))(text)
    return Option.getOrElse(Option.fromUndefinedOr(decoded.disabledExtensions), () => [])
  }).pipe(Effect.catchEager(() => Effect.succeed<ReadonlyArray<string>>([])))

/**
 * Whether the project side is a scope of its own. Launched from home, the
 * project's `.gent` is the user's, so there is one scope, read once: no
 * project config and no project extensions. Every reader of project files
 * asks this, with the two roots or the two extension directories. Paths
 * compare canonically; one that does not resolve compares as written.
 */
export const hasProjectScope = Effect.fn("ExtensionLoader.projectScope")(function* (sides: {
  readonly user: string
  readonly project: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const canonical = (dir: string) =>
    fs.realPath(path.resolve(dir)).pipe(Effect.orElseSucceed(() => path.resolve(dir)))
  return (yield* canonical(sides.project)) !== (yield* canonical(sides.user))
})

/**
 * Read disabled extensions from user + project config.
 * Same merge semantics as ConfigService: union of user + project lists.
 */
export const readDisabledExtensions = (params: { home: string; cwd: string }) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const userConfigPath = path.join(params.home, GENT_CONFIG_DIRECTORY, GENT_CONFIG_FILENAME)
    const projectConfigPath = path.join(params.cwd, GENT_CONFIG_DIRECTORY, GENT_CONFIG_FILENAME)
    const userDisabled = yield* readDisabledFromFile(userConfigPath)
    let projectDisabled: ReadonlyArray<string> = []
    if (yield* hasProjectScope({ user: params.home, project: params.cwd }))
      projectDisabled = yield* readDisabledFromFile(projectConfigPath)
    return new Set([...userDisabled, ...projectDisabled])
  })

// ── config-service ──────────────────────────────────────────────────────────

// User config schema - stored at ~/.gent/config.json

/**
 * One `providers` entry. Every field is optional and patches the models.dev
 * provider of the same id: `name`, `api` (a base URL; each `${VAR}` in it is
 * asked at sign-in), `env` (the key's variables), `class` (the id of the API
 * class that speaks every model, as `openai-chat`), `headers` (sent with
 * every request) and `models` (by model id, in the models.dev model shape).
 * `authOrder` names the credentials a turn walks; `authSpread` names a pool
 * of two or more of them that unpinned runs are spread over, each placed on
 * the least-used one where its prompt cache starts over anyway (credential
 * placement, runtime/provider.ts). A pool is opt-in: an order may hold a
 * billed key as a fallback that nobody wants spread onto. A pool that names
 * a credential its order does not (with no `authOrder`, the order is the
 * default alone) fails that sign-in, as conflicting orders do.
 * `extraUsage` lets a turn whose accounts all filled their windows go on
 * past them, on the plan's extra usage, instead of stopping until the
 * first reset (`ConfigService.extraUsage`). It is off by default, and only
 * the user file's counts: a project file never spends the owner's money.
 */
const ProviderConfigEntry = Schema.Struct({
  authOrder: Schema.optional(CredentialOrder.check(Schema.isMinLength(1))),
  authSpread: Schema.optional(CredentialOrder.check(Schema.isMinLength(2))),
  extraUsage: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  class: Schema.optional(Schema.String),
  api: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Array(Schema.String)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  models: Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  ),
})
export type ProviderConfigEntry = typeof ProviderConfigEntry.Type

/**
 * The owner's two ordered model lists, beside the account order: a machine
 * role of the `strongest` tier (plan, review) runs the first of its list with
 * a free lane; one of the `efficient` tier (implement, verify) runs the one
 * whose recent runs cost least per accepted unit. Intelligence is not
 * scored: the lists are the owner's.
 */
const ModelTiersConfig = Schema.Struct({
  strongest: Schema.optional(Schema.Array(ModelId).check(Schema.isMinLength(1))),
  efficient: Schema.optional(Schema.Array(ModelId).check(Schema.isMinLength(1))),
})

/**
 * The owner's Sabbath (`sabbath` in the user file): from sunset on Friday to
 * 30 minutes after sunset on Saturday at a place, its days counted in `timeZone` (an IANA
 * name). No run starts on the pool then and the running ones stop; the
 * owner's own turns answer as always. Each pool's pace spreads its weeks
 * over the hours outside it. With no `sabbath`, every hour is open.
 * `latitude` stays inside the polar circles, where the sun sets every day.
 */
export const Sabbath = Schema.Struct({
  latitude: Schema.Finite.check(Schema.isBetween({ minimum: -66, maximum: 66 })),
  longitude: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  timeZone: Schema.String.check(
    Schema.makeFilter((zone: string) => Option.isSome(DateTime.zoneMakeNamed(zone)), {
      message: "is not a time zone",
    }),
  ),
})
export type Sabbath = typeof Sabbath.Type

export class UserConfig extends Schema.Class<UserConfig, { readonly brand: unique symbol }>(
  "UserConfig",
)({
  disabledExtensions: Schema.optional(Schema.Array(Schema.String)),
  trustedProjects: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Per-agent model driver overrides. Keyed by agent name; the value is a
   * `DriverRef`. Project config shadows user config key-by-key — see
   * `mergeConfigs`.
   *
   * Read by `resolveSessionRoute` (runtime/turn.ts) to route an agent
   * through another model driver without editing its definition. E.g.
   * `{ main: { _tag: "Model", id: "openai" } }` sends `main`'s model name
   * to the OpenAI driver.
   */
  driverOverrides: Schema.optional(DriverOverridesFromConfig),
  /**
   * Agents by name, each an `AgentDefinition` without its `name` (an
   * `AgentPatch`). A name no extension registers creates an agent; one that
   * names a registered agent replaces the fields it sets. A project entry
   * replaces the fields it names over the user entry, and a run's own
   * `RunSpec.overrides` over both (`resolveAgentRoster`). An entry written
   * before `tools` keeps its meaning: `modelId` is `model`, both tool lists
   * are `tools`, and one list alone edits the tools the entry lands on (a
   * deny list takes ids away from them). A key the entry does not name fails
   * the file, naming the agent and the key (`AuthoredAgentPatch`), and a
   * turn in a cwd whose file does not load does not run (`getFresh`), so a
   * typo never drops the entry's restrictions. A config write leaves each
   * entry as the user wrote it: no key is added for an older gent, as a
   * stored row gets.
   */
  agents: Schema.optional(Schema.Record(AgentName, AuthoredAgentPatch)),
  /**
   * models.dev providers to enable, patch or add, by provider id. A key that
   * names a catalog provider enables it and patches its entry; a new key adds
   * a provider and needs `class`. Project config shadows user config
   * key-by-key. Read by the generic providers of runtime/provider.ts.
   */
  providers: Schema.optional(Schema.Record(Schema.String, ProviderConfigEntry)),
  /** Provider ids that get no generic driver, whatever their key or config. */
  disabledProviders: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The user's model: what an agent that names no model runs
   * (`resolveSessionRoute`). Gent ships no default model; the first `/model`
   * pick writes this field when the user config has none. A project entry
   * shadows the user's.
   */
  model: Schema.optional(ModelId),
  /** The owner's model tiers (`ModelTiersConfig`). A project list shadows the user's, list by list. */
  tiers: Schema.optional(ModelTiersConfig),
  /** The owner's Sabbath (`Sabbath`). Only the user file's counts. */
  sabbath: Schema.optional(Sabbath),
}) {}

/** The provider settings of a config: what the generic providers read. */
export type ProviderConfig = Pick<UserConfig, "providers" | "disabledProviders">

/** An empty list or record is stored as an absent field. */
const nonEmpty = <A>(items: ReadonlyArray<A>) =>
  Option.getOrUndefined(Option.liftPredicate(items, (list) => list.length > 0))

const nonEmptyRecord = <K extends string, A>(record: Readonly<Record<K, A>>) =>
  Option.getOrUndefined(Option.liftPredicate(record, (r) => Object.keys(r).length > 0))

/** Pure user-config transitions shared by the live and in-memory services. */
const configUpdates = {
  setDriverOverride: (current: UserConfig, agent: AgentName, driver: DriverRef): UserConfig =>
    new UserConfig({
      ...current,
      driverOverrides: { ...current.driverOverrides, [agent]: driver },
    }),
  /** `None` when the agent had no override, so callers can skip the save. */
  clearDriverOverride: (current: UserConfig, agent: AgentName): Option.Option<UserConfig> => {
    const existing = current.driverOverrides ?? {}
    if (!(agent in existing)) return Option.none()
    const next = { ...existing }
    delete next[agent]
    return Option.some(new UserConfig({ ...current, driverOverrides: nonEmptyRecord(next) }))
  },
  /** `None` when the config already names the user's model: the first pick stands. */
  setModelIfUnset: (current: UserConfig, model: ModelId): Option.Option<UserConfig> => {
    if (Predicate.isNotUndefined(current.model)) return Option.none()
    return Option.some(new UserConfig({ ...current, model }))
  },
  /**
   * `owner`'s `authOrder` set to `order` (an empty order clears it), and
   * the order of each entry in `aliases` cleared, so one entry holds the
   * sign-in's order. The pool keeps in step: each `authSpread` the entries
   * name keeps only the credentials `order` holds, and one left with fewer
   * than two goes, since a pool spreads over credentials of its order (a
   * removal takes the credential out of both). An entry left with no field
   * is removed. `None` when nothing changes.
   */
  setAuthOrder: (
    current: UserConfig,
    owner: string,
    order: ReadonlyArray<CredentialSlot>,
    aliases: ReadonlyArray<string>,
  ): Option.Option<UserConfig> => {
    const providers = { ...current.providers }
    let changed = false
    const write = (id: string, next: ReadonlyArray<CredentialSlot>) => {
      const { authOrder, authSpread, ...rest } = providers[id] ?? {}
      const pool = Option.filter(
        Option.map(Option.fromUndefinedOr(authSpread), (slots) =>
          slots.filter((slot) => order.includes(slot)),
        ),
        (slots) => slots.length >= 2,
      )
      const entry = {
        ...rest,
        ...omitUndefined({
          authOrder: Option.getOrUndefined(Option.liftPredicate(next, (slots) => slots.length > 0)),
          authSpread: Option.getOrUndefined(pool),
        }),
      }
      if (
        sameSlots(authOrder ?? [], next) &&
        sameSlots(
          authSpread ?? [],
          Option.getOrElse(pool, () => []),
        )
      )
        return
      changed = true
      if (Object.keys(entry).length > 0) providers[id] = entry
      else delete providers[id]
    }
    for (const alias of aliases) if (alias !== owner) write(alias, [])
    write(owner, order)
    if (!changed) return Option.none()
    return Option.some(new UserConfig({ ...current, providers: nonEmptyRecord(providers) }))
  },
  /**
   * The sign-in's order in this file with `from` relabeled `to`, written as
   * `setAuthOrder` writes it (into `owner`'s entry), and each pool an entry
   * of the sign-in names here relabeled with it. The order is the first
   * one `owner` or an entry in `aliases` names here. `None` when this file
   * names no order or pool that holds `from`: an order another file holds
   * is never copied into this one.
   */
  renameAuthSlot: (
    current: UserConfig,
    owner: string,
    aliases: ReadonlyArray<string>,
    from: CredentialSlot,
    to: CredentialSlot,
  ): Option.Option<UserConfig> => {
    const relabel = (slots: ReadonlyArray<CredentialSlot>) =>
      slots.map((slot) => {
        if (slot === from) return to
        return slot
      })
    const entries = signInEntryIds(owner, aliases)
    const providers = { ...current.providers }
    let changed = false
    for (const id of entries) {
      const entry = providers[id]
      if (Predicate.isUndefined(entry?.authSpread) || !entry.authSpread.includes(from)) continue
      providers[id] = { ...entry, authSpread: relabel(entry.authSpread) }
      changed = true
    }
    const relabeled = new UserConfig({ ...current, providers: nonEmptyRecord(providers) })
    const held = heldAuthOrder(current, owner, aliases).pipe(
      Option.filter((order) => order.includes(from)),
    )
    if (Option.isNone(held)) return Option.liftPredicate(relabeled, () => changed)
    const order = relabel(held.value)
    return Option.orElse(configUpdates.setAuthOrder(relabeled, owner, order, aliases), () =>
      Option.liftPredicate(relabeled, () => changed),
    )
  },
}

/** Whether two credential lists name the same slots in the same order. */
const sameSlots = (left: ReadonlyArray<CredentialSlot>, right: ReadonlyArray<CredentialSlot>) =>
  left.length === right.length && left.every((slot, index) => right[index] === slot)

/** The `providers` entries one sign-in reads: its owner's, then each alias's. */
const signInEntryIds = (owner: string, aliases: ReadonlyArray<string>) => [
  owner,
  ...aliases.filter((alias) => alias !== owner),
]

/**
 * The entries of `project` that win over a user-file order or pool of
 * `owner`'s sign-in: an entry for `owner` replaces the user's whole entry,
 * and an alias entry that names an order or a pool is read before the
 * user's.
 */
const shadowingOrderEntries = (
  project: UserConfig,
  owner: string,
  aliases: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const entries = project.providers ?? {}
  return signInEntryIds(owner, aliases).filter((id) => {
    const entry = entries[id]
    if (Predicate.isUndefined(entry)) return false
    return (
      id === owner ||
      Predicate.isNotUndefined(entry.authOrder) ||
      Predicate.isNotUndefined(entry.authSpread)
    )
  })
}

/** The sign-in's order in one file: the first one `owner` or an entry in `aliases` names. */
const heldAuthOrder = (
  config: UserConfig,
  owner: string,
  aliases: ReadonlyArray<string>,
): Option.Option<ReadonlyArray<CredentialSlot>> =>
  Option.fromUndefinedOr(
    [owner, ...aliases]
      .map((id) => config.providers?.[id]?.authOrder)
      .find(Predicate.isNotUndefined),
  )

/** What a refusal calls each list of a sign-in's credentials. */
const LIST_NAME = { authOrder: "order", authSpread: "pool" } as const

/** Every order and pool `entries` of `config` name, by the entry and the field. */
const credentialLists = (
  config: UserConfig,
  entries: ReadonlyArray<string>,
): ReadonlyArray<{
  readonly id: string
  readonly field: "authOrder" | "authSpread"
  readonly slots: ReadonlyArray<CredentialSlot>
}> =>
  entries.flatMap((id) => {
    const entry = config.providers?.[id]
    return (["authOrder", "authSpread"] as const).flatMap((field) => {
      const slots = entry?.[field]
      if (Predicate.isUndefined(slots)) return []
      return [{ id, field, slots }]
    })
  })

/** The opening of a refusal that names project entries winning over the user file. */
export const projectEntriesText = (ids: ReadonlyArray<string>) =>
  `The project config (.gent/config.json) has an entry for ${ids.map((id) => `"${id}"`).join(", ")}`

/**
 * Why `owner`'s credential `from` cannot be relabeled `to`, read before
 * anything moves; none when it can. A project entry that wins over the
 * user file (`shadowingOrderEntries`) and names `from` in its order or its
 * pool refuses it: that list would then name a label no credential holds.
 * An order or pool the user file or such an entry holds that names `to`
 * refuses it: the list would name the moved credential twice, or enrol it
 * where the user never put it.
 */
const authSlotRenameRefusal = (params: {
  readonly user: UserConfig
  readonly project: UserConfig
  readonly owner: string
  readonly aliases: ReadonlyArray<string>
  readonly from: CredentialSlot
  readonly to: CredentialSlot
}): Option.Option<string> => {
  const projectLists = credentialLists(
    params.project,
    shadowingOrderEntries(params.project, params.owner, params.aliases),
  )
  const keepsFrom = projectLists.filter(({ slots }) => slots.includes(params.from))
  if (keepsFrom.length > 0) {
    const ids = [...new Set(keepsFrom.map(({ id }) => id))]
    const fields = [...new Set(keepsFrom.map(({ field }) => field))].join(" or ")
    return Option.some(
      `${projectEntriesText(ids)}, whose ${fields} names "${params.from}": edit it there first`,
    )
  }
  const lists = [
    ...credentialLists(params.user, signInEntryIds(params.owner, params.aliases)),
    ...projectLists,
  ]
  const holdsTo = lists.find(({ slots }) => slots.includes(params.to))
  if (Predicate.isNotUndefined(holdsTo)) {
    return Option.some(
      `"${params.to}" is in the ${holdsTo.field} of "${params.owner}": move it out of the ${LIST_NAME[holdsTo.field]} first, or pick another label`,
    )
  }
  return Option.none()
}

/** User then project `agents` entries: a project entry replaces only the fields it names. */
const mergeAgentEntries = (
  user: Readonly<Record<AgentName, StoredAgentPatch>>,
  project: Readonly<Record<AgentName, StoredAgentPatch>>,
): Readonly<Record<AgentName, StoredAgentPatch>> => {
  const merged: Record<AgentName, StoredAgentPatch> = { ...user }
  for (const [key, patch] of Object.entries(project)) {
    const name = AgentName.make(key)
    merged[name] = mergeAgentPatches(merged[name] ?? {}, patch)
  }
  return merged
}

/**
 * Merge user + project configs. Per-field semantics:
 *   - disabledExtensions: concatenated (user first — historical order).
 *   - disabledProviders: concatenated, user first.
 *   - agents: by name, a project entry replaces the fields it names in the
 *     user entry (`mergeAgentPatches`).
 *   - driverOverrides, providers: object spread; project entries shadow user
 *     entries key-by-key. Idempotent set/clear is the load-bearing property —
 *     `Record<agent, DriverRef>` (vs `Array`) means `driver.set` / `clear`
 *     map directly to `record[name] = ref` / `delete record[name]`.
 */
const mergeConfigs = (user: UserConfig, project: UserConfig): UserConfig =>
  new UserConfig({
    disabledExtensions: nonEmpty([
      ...(user.disabledExtensions ?? []),
      ...(project.disabledExtensions ?? []),
    ]),
    driverOverrides: nonEmptyRecord({ ...user.driverOverrides, ...project.driverOverrides }),
    agents: nonEmptyRecord(mergeAgentEntries(user.agents ?? {}, project.agents ?? {})),
    providers: nonEmptyRecord({ ...user.providers, ...project.providers }),
    disabledProviders: nonEmpty([
      ...(user.disabledProviders ?? []),
      ...(project.disabledProviders ?? []),
    ]),
    model: project.model ?? user.model,
    tiers: Option.getOrUndefined(
      Option.liftPredicate(
        omitUndefined({
          strongest: project.tiers?.strongest ?? user.tiers?.strongest,
          efficient: project.tiers?.efficient ?? user.tiers?.efficient,
        }),
        (tiers) => Object.keys(tiers).length > 0,
      ),
    ),
  })

/** A config file as JSON, with every key, known to `UserConfig` or not. */
const RawConfigJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
type RawConfig = typeof RawConfigJson.Type

const isRawObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

/** The raw keys of an entry that neither decoded side knows. */
const unknownKeys = (raw: RawConfig, before: RawConfig, after: RawConfig): RawConfig =>
  Object.fromEntries(Object.entries(raw).filter(([key]) => !(key in before) && !(key in after)))

/**
 * A changed record-of-struct field (`driverOverrides`). Its keys
 * follow `after`: an entry the decode dropped (a retired driver ref) or the
 * change cleared is removed. An entry `before` also decoded keeps the raw
 * keys gent does not know, under the encoded `after` entry.
 */
const mergeEntries = (raw: RawConfig, before: RawConfig, after: RawConfig): RawConfig =>
  Object.fromEntries(
    Object.entries(after).map(([key, now]) => {
      const current = raw[key]
      const was = before[key]
      if (isRawObject(current) && isRawObject(was) && isRawObject(now)) {
        return [key, { ...unknownKeys(current, was, now), ...now }]
      }
      return [key, now]
    }),
  )

/**
 * The record-of-struct fields a config write changes: `driverOverrides`,
 * and `providers` (its `authOrder`). A field no write changes never reaches
 * the merge, because `mergeChangedFields` skips an unchanged field, so a
 * write keeps each `agents` entry as the user wrote it. A new writer for
 * another record-of-struct field (`agents`) adds it here.
 */
const ENTRY_FIELDS: ReadonlySet<string> = new Set(["driverOverrides", "providers"])

/**
 * `raw` with each `UserConfig` field that differs between `before` and
 * `after` (both encoded) set to its `after` value, or removed when `after`
 * leaves it out. A changed entry field keeps the unknown keys inside its
 * entries (`mergeEntries`). Every other key of `raw` is kept as it is.
 */
const mergeChangedFields = (raw: RawConfig, before: RawConfig, after: RawConfig): RawConfig => {
  const merged = { ...raw }
  for (const key of Object.keys(UserConfig.fields)) {
    const now = after[key]
    if (Equal.equals(before[key], now)) continue
    if (!(key in after)) delete merged[key]
    else {
      const current = raw[key]
      const was = before[key]
      if (ENTRY_FIELDS.has(key) && isRawObject(current) && isRawObject(was) && isRawObject(now)) {
        merged[key] = mergeEntries(current, was, now)
      } else merged[key] = now
    }
  }
  return merged
}

/** The agents whose stored override names a removed external driver. */
const StoredDriverOverrides = Schema.Struct({
  driverOverrides: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
const retiredOverrideAgents = (content: string): ReadonlyArray<string> =>
  Option.match(Schema.decodeOption(Schema.fromJsonString(StoredDriverOverrides))(content), {
    onNone: () => [],
    onSome: (stored) =>
      Object.entries(stored.driverOverrides ?? {})
        .filter(([, ref]) => isRetiredDriverRef(ref))
        .map(([agent]) => agent),
  })

const configEscapes = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["b", "\b"],
])

/**
 * A git config value as git reads it: quotes removed, `\` escapes read, a
 * `#` or `;` comment outside quotes dropped, and the whitespace around it
 * outside quotes dropped.
 */
const configValue = (raw: string) => {
  let value = ""
  let kept = 0
  let quoted = false
  for (let index = 0; index < raw.length; index++) {
    const char = raw.charAt(index)
    if (char === '"') {
      quoted = !quoted
      kept = value.length
    } else if (char === "\\") {
      index++
      const escaped = raw.charAt(index)
      value += configEscapes.get(escaped) ?? escaped
      kept = value.length
    } else if (!quoted && (char === "#" || char === ";")) break
    else if (quoted || !/\s/.test(char)) {
      value += char
      kept = value.length
    } else if (value.length > 0) value += char
  }
  return value.slice(0, kept)
}

/**
 * The subsection of a `[<section> "<name>"]` header line, its escapes read;
 * none for a header of another section. Section names ignore case.
 */
const subsectionOf = (line: string, section: string) => {
  const match = /^\[([a-z0-9.-]+)\s+"((?:[^"\\]|\\.)*)"\]\s*(?:[#;].*)?$/i.exec(line)
  if (match?.[1]?.toLowerCase() !== section) return Option.none<string>()
  return Option.map(Option.fromUndefinedOr(match[2]), (name) => name.replace(/\\(.)/g, "$1"))
}

/**
 * A remote url without its scheme, user and `.git`: `git@host:owner/repo.git`
 * and `https://host/owner/repo` are `host/owner/repo`. A scheme url keeps its
 * port (`ssh://git@host:2222/owner/repo` is `host:2222/owner/repo`); the
 * scp form has none, so its colon only ends the host.
 */
const remoteName = (url: string) => {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?(.*)$/i.exec(url)?.[1]
  let named = url.replace(/^[^@/]+@/, "").replace(/^([^/:]+):/, "$1/")
  if (Predicate.isNotUndefined(scheme)) named = scheme
  return named.replace(/(\.git)?\/*$/, "")
}

/** The url of a git config's `[remote "origin"]`; none without one. */
const originUrl = (config: string): Option.Option<string> => {
  let inOrigin = false
  for (const raw of config.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("[")) inOrigin = Option.contains(subsectionOf(line, "remote"), "origin")
    else if (inOrigin) {
      const url = /^url\s*=\s*(.+)$/.exec(line)?.[1]
      if (Predicate.isNotUndefined(url)) return Option.some(configValue(url))
    }
  }
  return Option.none()
}

/**
 * `url` as git fetches it: a `[url "<base>"]` section's `insteadOf = <prefix>`
 * in any of `configs` puts `<base>` in place of the prefix. The longest
 * prefix wins; of two as long, the one git reads first (`configs` is in
 * git's read order).
 */
const rewrittenUrl = (url: string, configs: ReadonlyArray<string>) => {
  let match = { prefix: "", base: "" }
  for (const config of configs) {
    let base = Option.none<string>()
    for (const raw of config.split("\n")) {
      const line = raw.trim()
      if (line.startsWith("[")) base = subsectionOf(line, "url")
      else if (Option.isSome(base)) {
        const prefix = /^insteadof\s*=\s*(.+)$/i.exec(line)?.[1]
        if (Predicate.isUndefined(prefix)) continue
        const named = configValue(prefix)
        if (url.startsWith(named) && named.length > match.prefix.length)
          match = { prefix: named, base: base.value }
      }
    }
  }
  return match.base + url.slice(match.prefix.length)
}

/**
 * The `origin` of the repository at `root`, as `git:<remoteName>`. Its `.git`
 * is `dotGit`: a directory, or a file (`linked`, a worktree) naming its git
 * directory, whose `commondir` names the one that holds the config. The url
 * is rewritten as git rewrites it (`rewrittenUrl`) by that config and the
 * user's global ones (`~/.config/git/config`, `~/.gitconfig`); the system
 * config, `XDG_CONFIG_HOME` and `include` are not read.
 */
const repositoryOrigin = Effect.fn("Config.repositoryOrigin")(function* (
  root: string,
  dotGit: string,
  linked: boolean,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const read = (file: string) => Effect.option(fs.readFileString(file))
  let gitDir = dotGit
  if (linked) {
    const named = Option.flatMap(yield* read(dotGit), (text) =>
      Option.fromUndefinedOr(/^gitdir:\s*(.+)$/m.exec(text)?.[1]),
    )
    if (Option.isNone(named)) return Option.none<string>()
    gitDir = path.resolve(root, named.value.trim())
  }
  const common = Option.match(yield* read(path.join(gitDir, "commondir")), {
    onNone: () => gitDir,
    onSome: (text) => path.resolve(gitDir, text.trim()),
  })
  const config = yield* read(path.join(common, "config"))
  const origin = Option.flatMap(config, originUrl)
  if (Option.isNone(origin)) return Option.none<string>()
  const globals = yield* Effect.forEach(
    // Git reads the XDG file before `~/.gitconfig`.
    [path.join(home, ".config", "git", "config"), path.join(home, ".gitconfig")],
    read,
  )
  const configs = [...globals, config].flatMap((text) => Option.toArray(text))
  return Option.some(`git:${remoteName(rewrittenUrl(origin.value, configs))}`)
})

/**
 * The project `dir` works in: the nearest directory
 * at or above it that holds `.git`, named by the repository's `origin`, so
 * a clone, a worktree and a rift of one repository are one project; by the
 * root's real path when it has no origin; by `dir`'s own when no repository
 * holds it.
 */
const projectOf = Effect.fn("Config.projectOf")(function* (dir: string, home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const start = yield* fs
    .realPath(path.resolve(dir))
    .pipe(Effect.orElseSucceed(() => path.resolve(dir)))
  const ancestors = [start]
  for (let parent = path.dirname(start); !ancestors.includes(parent); parent = path.dirname(parent))
    ancestors.push(parent)
  for (const root of ancestors) {
    const dotGit = path.join(root, ".git")
    const info = yield* Effect.option(fs.stat(dotGit))
    if (Option.isNone(info)) continue
    const origin = yield* repositoryOrigin(root, dotGit, info.value.type === "File", home)
    return Option.getOrElse(origin, () => root)
  }
  return start
})

// ConfigService

interface ConfigServiceService {
  /**
   * The merged user + project config as the files are now, so a hand edit
   * reaches the next read without a restart. Pass `cwd` whenever the
   * consumer acts for a session: a multi-cwd server (sessions in /a, /b, /c)
   * cannot rely on the launch cwd's `.gent/config.json` to carry project
   * overrides for everyone. Without `cwd`, reads the launch cwd's project
   * config. A file that does not decode reads as `getFresh` says.
   */
  readonly get: (cwd?: string) => Effect.Effect<UserConfig>
  /**
   * `get` with the files that did not load. A file that does not decode
   * never stops the read: it is reported in `failures` and read as the last
   * user config that loaded (user) or as empty (project). Either reading can
   * be wider than the file the user wrote, so a turn reads `getFresh` and
   * does not run while `failures` is not empty (`resolveTurnContext`);
   * health, providers and the route a client reads use the lenient config.
   */
  readonly getFresh: (cwd: string) => Effect.Effect<FreshConfig>
  /** The project `cwd` works in (`projectOf`). */
  readonly project: (cwd: string) => Effect.Effect<string>
  /**
   * Whether a turn on `owner`'s sign-in goes on past every account's full
   * window (`providers.<owner>.extraUsage`). Only the user file counts.
   */
  readonly extraUsage: (owner: string) => Effect.Effect<boolean>
  /** The user file's Sabbath (`Sabbath`); none keeps every hour open. */
  readonly sabbath: Effect.Effect<Option.Option<Sabbath>>
  /** Set a per-agent driver override. Replaces any existing entry for `agent`.
   *  The write starts from the user config on disk now, so a hand edit
   *  made while gent runs survives. Fails with
   *  `ConfigLoadError` when that file does not decode (writing would discard
   *  every setting in it) and with `ConfigWriteError` when the file cannot be
   *  replaced. */
  readonly setDriverOverride: (
    agent: AgentName,
    driver: DriverRef,
  ) => Effect.Effect<void, ConfigLoadError | ConfigWriteError>
  /** Remove a per-agent driver override. No-op when the agent has none. */
  readonly clearDriverOverride: (
    agent: AgentName,
  ) => Effect.Effect<void, ConfigLoadError | ConfigWriteError>
  /**
   * Write `model` as the user's model when the user config names none;
   * no-op otherwise. The first `/model` pick names the user's model this
   * way. Fails as `setDriverOverride` does.
   */
  readonly setModelIfUnset: (
    model: ModelId,
  ) => Effect.Effect<void, ConfigLoadError | ConfigWriteError>
  /**
   * Write a sign-in's credential order into the user config: `owner`'s
   * `providers` entry gets `order` (empty: the field goes, and the default
   * credential serves alone), and each entry in `aliases` (a driver that
   * shares the sign-in) loses its own, so no two entries can conflict.
   * Where the project config of `cwd` holds an entry that wins over it, the
   * call writes nothing and returns those entries: an order the user was
   * refused never lands in a file every other project reads. Fails as
   * `setDriverOverride` does.
   */
  readonly setAuthOrder: (
    owner: string,
    order: ReadonlyArray<CredentialSlot>,
    aliases: ReadonlyArray<string>,
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<string>, ConfigLoadError | ConfigWriteError>
  /**
   * Relabel the sign-in's credential `from` as `to` (`owner` and its
   * `aliases`), under the user-config write permit. Refused, with the
   * reason and nothing moved, when an order of the user file or of a project
   * entry of `cwd` that wins would break (`authSlotRenameRefusal`). Else
   * `move` relabels the credential, then the order the user file holds
   * follows it (`configUpdates.renameAuthSlot`); a project order is never
   * copied into the user file. An order write waits for it, so none lands
   * between the check and the rewrite; a `move` that fails writes nothing.
   * Fails as `setDriverOverride` does.
   */
  readonly renameAuthSlot: <E, R>(params: {
    readonly owner: string
    readonly aliases: ReadonlyArray<string>
    readonly from: CredentialSlot
    readonly to: CredentialSlot
    readonly cwd: string
    readonly move: Effect.Effect<void, E, R>
  }) => Effect.Effect<Option.Option<string>, E | ConfigLoadError | ConfigWriteError, R>
}

/**
 * One config file as a read found it: its text, missing, or not readable
 * (the read failed; a file that is not JSON is `Read`).
 */
const ConfigFileRead = Schema.TaggedUnion({
  Read: { path: Schema.String, text: Schema.String },
  Missing: { path: Schema.String },
  Unreadable: { path: Schema.String, message: Schema.String },
})
type ConfigFileRead = typeof ConfigFileRead.Type

/**
 * A fresh config read: the merged config, every file that did not load, the
 * files as the read found them (`files`), and what they hold
 * (`fingerprint`). `config` holds only the fields core decodes, and an
 * extension reads its own keys from the same files at setup (`guard`,
 * `routers`). A session profile is built from one read: its key holds the
 * fingerprint, and its setups read `files` (`configSnapshotFileSystem`), so
 * the profile and its key agree. The fingerprint names every key of the
 * files but `disabledExtensions`, which the profile key holds as its effect
 * (the extensions that run); a missing file is the same as `{}`, and a file
 * that cannot be read is `unreadable`.
 */
export interface FreshConfig {
  readonly config: UserConfig
  readonly failures: ReadonlyArray<ConfigLoadError>
  readonly files: ReadonlyArray<ConfigFileRead>
  readonly fingerprint: string
}

const ConfigJson = Schema.fromJsonString(Schema.Json)

const isJsonRecord = (json: Schema.Json): json is { readonly [key: string]: Schema.Json } =>
  Predicate.isObject(json) && !Array.isArray(json)

/** A config text's keys as canonical JSON, the disabled list left out; `invalid` when it is not JSON. */
const configFingerprint = (content: string): string =>
  Result.match(Schema.decodeResult(ConfigJson)(content), {
    onFailure: () => "invalid",
    onSuccess: (json) => {
      if (!isJsonRecord(json)) return canonicalJsonString(json)
      return canonicalJsonString(
        Object.fromEntries(Object.entries(json).filter(([key]) => key !== "disabledExtensions")),
      )
    },
  })

/** What the files hold, in read order: each one's keys, or `unreadable`. */
const configFilesFingerprint = (files: ReadonlyArray<ConfigFileRead>): string =>
  files
    .map((file) =>
      ConfigFileRead.match(file, {
        Read: ({ path, text }) => `${path}=${configFingerprint(text)}`,
        Missing: ({ path }) => `${path}=${configFingerprint("{}")}`,
        Unreadable: ({ path }) => `${path}=unreadable`,
      }),
    )
    .join("\u0000")

/**
 * A file system that answers reads of the config files from one read of
 * them (`files`): `exists` and `readFile`/`readFileString` of a config path
 * give what the read found, a missing file is `NotFound`, and a file the read
 * could not read fails again. Every other path, and every other operation,
 * goes to `fs`. A profile build runs its extension scan and setups over it,
 * so what they read of the config is what the profile key names.
 */
export const configSnapshotFileSystem = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  files: ReadonlyArray<ConfigFileRead>,
): FileSystem.FileSystem => {
  const byPath = new Map(files.map((file) => [path.resolve(file.path), file]))
  const answer = <A>(
    method: string,
    filePath: string,
    read: (text: string) => A,
    otherwise: Effect.Effect<A, PlatformError.PlatformError>,
  ): Effect.Effect<A, PlatformError.PlatformError> =>
    Option.match(Option.fromUndefinedOr(byPath.get(path.resolve(filePath))), {
      onNone: () => otherwise,
      onSome: (file) =>
        ConfigFileRead.match(file, {
          Read: ({ text }): Effect.Effect<A, PlatformError.PlatformError> =>
            Effect.succeed(read(text)),
          Missing: () =>
            Effect.fail(
              // oxlint-disable-next-line effect/preferTaggedConstructors -- `_tag` is the reason option systemError takes, not a tagged value
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method,
                pathOrDescriptor: filePath,
                description: "No such file or directory",
              }),
            ),
          Unreadable: ({ message }) =>
            Effect.fail(
              // oxlint-disable-next-line effect/preferTaggedConstructors -- `_tag` is the reason option systemError takes, not a tagged value
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method,
                pathOrDescriptor: filePath,
                description: message,
              }),
            ),
        }),
    })
  return FileSystem.make({
    ...fs,
    access: (filePath, options) =>
      answer("access", filePath, Function.constVoid, fs.access(filePath, options)),
    readFile: (filePath) =>
      answer("readFile", filePath, (text) => new TextEncoder().encode(text), fs.readFile(filePath)),
  })
}

export class ConfigLoadError extends Schema.TaggedError<
  ConfigLoadError,
  { readonly brand: unique symbol }
>()("ConfigLoadError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** The user config could not be written; the file on disk is unchanged. */
export class ConfigWriteError extends Schema.TaggedError<
  ConfigWriteError,
  { readonly brand: unique symbol }
>()("ConfigWriteError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * A file's version as its stat tells it: mtime (ms), size and inode. The
 * inode tells an atomic replace (a rename) of the same size and clock tick
 * apart from the file it replaced. A same-size rewrite in place within one
 * tick of the file clock (milliseconds on Linux, up to two seconds on FAT)
 * keeps the version, and a stat inside an in-place save can see the new
 * version over the old bytes; `File.Info` has no ctime, and a ctime ticks
 * with the same clock. So a stamp taken within one tick of its mtime is not
 * proof of the bytes (`fileStamp`).
 */
const fileVersion = (info: FileSystem.File.Info): string => {
  const mtime = Option.match(info.mtime, {
    onNone: () => "",
    onSome: (date) => String(date.getTime()),
  })
  const inode = Option.match(info.ino, { onNone: () => "", onSome: String })
  return `${mtime}:${String(info.size)}:${inode}`
}

/**
 * How old a file's mtime must be before its stat stamp is trusted: the
 * racy-git rule (git's `Documentation/technical/racy-git.adoc`), where an
 * entry not older than the index that recorded it is compared by content.
 *
 * A file's clock ticks coarser than the millisecond of its stamp, and an
 * in-place save sets the mtime before it copies the bytes. A stat in that
 * tick can see the new stamp over the old bytes, and a save that ends in the
 * same tick keeps that stamp. So a stamp whose mtime is within one tick of
 * the stat is kept as `RACY_STAMP`, which no stat matches, and the bytes
 * decide. The tick is the coarsest clock a user's files can sit on: the
 * kernel's coarse clock on Linux before multigrain timestamps (4 ms at
 * `HZ=250`, 10 ms at `HZ=100`), one second on HFS+ and two on FAT. Two
 * seconds covers all of them; an mtime in the future (a skewed network
 * clock) is always racy.
 */
const RACY_STAMP_MILLIS = 2_000
/** A kept stamp no stat matches, so the next look reads the bytes. */
export const RACY_STAMP = "racy"

/**
 * A file's stat stamp now (`fileVersion`, or `missing` when it is gone):
 * `seen` to compare with a kept stamp, and `kept` to keep, which is
 * `RACY_STAMP` when the mtime is within one tick of the file clock. The
 * config read cache and the extension loader both keep stamps this way.
 */
export const fileStamp = Effect.fn("FileStamp.stat")(function* (
  fs: FileSystem.FileSystem,
  file: string,
) {
  const now = yield* Clock.currentTimeMillis
  const info = yield* fs.stat(file).pipe(Effect.option)
  const seen = Option.match(info, { onNone: () => "missing", onSome: fileVersion })
  const racy = Option.flatMap(info, (found) => found.mtime).pipe(
    Option.exists((mtime) => mtime.getTime() > now - RACY_STAMP_MILLIS),
  )
  if (racy) return { seen, kept: RACY_STAMP }
  return { seen, kept: seen }
})

export class ConfigService extends Context.Service<ConfigService, ConfigServiceService>()(
  "@gent/core/src/runtime/config/ConfigService",
) {
  /**
   * Where a config file sits, relative to $HOME for the user config and to
   * the project root for the project config. One path, because both files
   * carry the same schema at the same place under their own root.
   */
  static CONFIG_RELATIVE = `${GENT_CONFIG_DIRECTORY}/${GENT_CONFIG_FILENAME}`

  static Live: Layer.Layer<
    ConfigService,
    never,
    FileSystem.FileSystem | Path.Path | RuntimeEnvironment
  > = Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const runtimeEnvironment = yield* RuntimeEnvironment
      const home = runtimeEnvironment.home
      const userConfigPath = path.join(home, ConfigService.CONFIG_RELATIVE)

      const UserConfigJson = Schema.fromJsonString(UserConfig)
      const defaultUserConfig = new UserConfig({})

      // The last user config that decoded. It stands in for a user file that
      // stops decoding, and its lock orders writers and the reads of a changed
      // user file. Reads take the files as they are now, so a hand edit
      // reaches the next read without a restart.
      const userConfigRef = yield* SynchronizedRef.make<UserConfig>(new UserConfig({}))

      const ensureUserConfig = Effect.gen(function* () {
        const exists = yield* fs.exists(userConfigPath)
        if (exists) return
        const configDir = path.dirname(userConfigPath)
        yield* fs.makeDirectory(configDir, { recursive: true })
        const json = yield* Schema.encodeEffect(UserConfigJson)(defaultUserConfig)
        yield* fs.writeFileString(userConfigPath, json, { flag: "wx" }).pipe(
          Effect.catchEager((error) => {
            if (error.reason._tag === "AlreadyExists") return Effect.void
            return Effect.fail(error)
          }),
        )
      }).pipe(
        Effect.catchEager((e) =>
          Effect.logWarning("Config init failed").pipe(Effect.annotateLogs({ error: String(e) })),
        ),
      )

      // A file's warning is said once per file and content, not on every
      // read of a project config.
      const warnedKeys = yield* Ref.make<ReadonlySet<string>>(new Set())
      const warnOnce = (key: string, warning: Effect.Effect<void>) =>
        Effect.gen(function* () {
          const warned = yield* Ref.modify(warnedKeys, (keys) => [
            keys.has(key),
            new Set([...keys, key]),
          ])
          if (!warned) yield* warning
        })

      // A stored override that names a removed external driver decodes as absent.
      const warnRetiredOverrides = (filePath: string, content: string) =>
        Effect.gen(function* () {
          const agents = retiredOverrideAgents(content)
          if (agents.length === 0) return
          yield* warnOnce(
            `retired\0${filePath}`,
            Effect.logWarning(
              "Config names a removed external driver; the agent uses its default model",
            ).pipe(Effect.annotateLogs({ path: filePath, agents: agents.join(", ") })),
          )
        })

      // `extraUsage` and `sabbath` count only in the user file: a project
      // file that sets them is read without them, and says so.
      const warnUserOnlyFields = (filePath: string, project: UserConfig) =>
        Effect.gen(function* () {
          const fields: Array<string> = []
          if (Predicate.isNotUndefined(project.sabbath)) fields.push("sabbath")
          for (const [owner, entry] of Object.entries(project.providers ?? {}))
            if (Predicate.isNotUndefined(entry.extraUsage))
              fields.push(`providers.${owner}.extraUsage`)
          if (fields.length === 0) return
          // The key is the set: a file that reorders its providers warns no more.
          fields.sort(Order.String)
          yield* warnOnce(
            `user-only\0${filePath}\0${fields.join(",")}`,
            Effect.logWarning(
              "Project config sets fields only the user config counts; they are ignored",
            ).pipe(Effect.annotateLogs({ path: filePath, fields: fields.join(", ") })),
          )
        })

      // A missing file reads as an empty config.
      const readConfigText = (filePath: string) =>
        fs.exists(filePath).pipe(
          Effect.flatMap((exists) => {
            if (exists) return fs.readFileString(filePath)
            return Effect.succeed("{}")
          }),
        )

      const loadError = (filePath: string) => (cause: unknown) =>
        new ConfigLoadError({ path: filePath, message: String(cause) })

      const decodeConfigText = (
        filePath: string,
        content: string,
      ): Effect.Effect<UserConfig, ConfigLoadError> =>
        warnRetiredOverrides(filePath, content).pipe(
          Effect.andThen(Schema.decodeEffect(UserConfigJson)(content)),
          Effect.mapError(loadError(filePath)),
        )

      // The read of each file, kept while its stat (mtime, size and inode) is
      // the same, so a turn does not read and decode unchanged files. A
      // changed or new file is read at once; a missing one reads as empty. A
      // stamp within one tick of the file clock is kept as `RACY_STAMP`, so
      // the file is read again until its last save ages (`fileStamp`).
      // Only a read is kept: a read that failed (EMFILE, a permission changed
      // and back) is tried again on the next call, since the stat need not
      // change. An entry holds the decode and what the file held (`file`).
      interface KeptRead {
        readonly stamp: string
        readonly read: Result.Result<UserConfig, ConfigLoadError>
        readonly file: ConfigFileRead
      }
      const keptReads = new Map<string, KeptRead>()
      /** The file as it is now; fails only when it cannot be read. */
      const readConfigFile = (filePath: string): Effect.Effect<KeptRead, ConfigLoadError> =>
        Effect.gen(function* () {
          const stamp = yield* fileStamp(fs, filePath)
          const cached = Option.fromUndefinedOr(keptReads.get(filePath))
          if (Option.isSome(cached) && cached.value.stamp === stamp.seen) return cached.value
          const text = yield* fs.exists(filePath).pipe(
            Effect.flatMap((exists) => {
              if (exists) return Effect.asSome(fs.readFileString(filePath))
              return Effect.succeedNone
            }),
            Effect.mapError(loadError(filePath)),
          )
          const read = yield* Effect.result(
            decodeConfigText(
              filePath,
              Option.getOrElse(text, () => "{}"),
            ),
          )
          const file = Option.match(text, {
            onNone: () => ConfigFileRead.cases.Missing.make({ path: filePath }),
            onSome: (content) => ConfigFileRead.cases.Read.make({ path: filePath, text: content }),
          })
          const kept: KeptRead = { stamp: stamp.kept, read, file }
          keptReads.set(filePath, kept)
          return kept
        })
      const unreadable = (error: ConfigLoadError) =>
        ConfigFileRead.cases.Unreadable.make({ path: error.path, message: error.message })

      // The user file as it is now. An unchanged file answers from the kept
      // read without the lock. A changed one is read under the writers'
      // lock, and publishes the decode there: reads and writes of the user
      // file take turns, so the config published last is the file read last,
      // and a read that raced a write cannot put the older config back.
      const readUserConfig: Effect.Effect<Result.Result<KeptRead, ConfigLoadError>> = Effect.gen(
        function* () {
          const { seen } = yield* fileStamp(fs, userConfigPath)
          const cached = Option.fromUndefinedOr(keptReads.get(userConfigPath))
          if (Option.isSome(cached) && cached.value.stamp === seen)
            return Result.succeed(cached.value)
          return yield* SynchronizedRef.modifyEffect(userConfigRef, (current) =>
            Effect.result(readConfigFile(userConfigPath)).pipe(
              Effect.map((kept) => [
                kept,
                Result.match(kept, {
                  onSuccess: ({ read }) => Result.getOrElse(read, () => current),
                  onFailure: () => current,
                }),
              ]),
            ),
          )
        },
      )

      // Seed the last-decoded user config. A user file that will not decode
      // reads as empty for the lenient readers; a turn does not run until it
      // is fixed (`getFresh`). Writes never start from this snapshot: each
      // one reads the user file again and refuses when it does not decode.
      const loadUserConfig = readUserConfig.pipe(
        Effect.flatMap((kept) =>
          Result.match(
            Result.flatMap(kept, ({ read }) => read),
            {
              onSuccess: () => Effect.void,
              onFailure: (error) =>
                Effect.logWarning("Config load failed — writes refused until it is fixed").pipe(
                  Effect.annotateLogs({ path: userConfigPath, error: error.message }),
                ),
            },
          ),
        ),
      )

      // Replace the user config through a staged sibling, so a reader (or a
      // crash) never sees a half-written file. Only the fields the update
      // changed are written into the file as it was read: a key this build
      // does not know (a newer build's field, a hand edit), and the unknown
      // parts of a known field left unchanged, stay as they are.
      const saveUserConfig = (raw: RawConfig, before: UserConfig, after: UserConfig) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(userConfigPath), { recursive: true })
          const asRaw = (config: UserConfig) =>
            Schema.encodeEffect(UserConfigJson)(config).pipe(
              Effect.flatMap(Schema.decodeEffect(RawConfigJson)),
            )
          const json = yield* Schema.encodeEffect(RawConfigJson)(
            mergeChangedFields(raw, yield* asRaw(before), yield* asRaw(after)),
          )
          yield* writeFileAtomic(userConfigPath, json)
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) => new ConfigWriteError({ path: userConfigPath, message: String(cause) }),
          ),
        )

      // Initial load
      yield* ensureUserConfig
      yield* loadUserConfig

      // The ref orders writers; the file is the source. Deciding on the file
      // as it is now keeps a hand edit made since the last read, and a file
      // that does not decode fails here instead of being replaced. `decide`
      // runs under the permit, so what it checks and what it writes are one
      // step: no other writer lands between them.
      const writeUserConfig = <A, E, R>(
        decide: (current: UserConfig) => Effect.Effect<
          {
            readonly updated: UserConfig
            readonly save: boolean
            readonly result: A
          },
          E,
          R
        >,
      ): Effect.Effect<A, E | ConfigLoadError | ConfigWriteError, R> =>
        SynchronizedRef.modifyEffect(userConfigRef, () =>
          Effect.gen(function* () {
            const [raw, onDisk] = yield* readConfigText(userConfigPath).pipe(
              Effect.flatMap((content) =>
                Effect.all([
                  Schema.decodeEffect(RawConfigJson)(content),
                  Schema.decodeEffect(UserConfigJson)(content),
                ]),
              ),
              Effect.mapError(
                (cause) => new ConfigLoadError({ path: userConfigPath, message: String(cause) }),
              ),
            )
            const decision = yield* decide(onDisk)
            if (decision.save) yield* saveUserConfig(raw, onDisk, decision.updated)
            return [decision.result, decision.updated] as const
          }),
        )
      const mutateUserConfig = (
        decide: (current: UserConfig) => {
          readonly updated: UserConfig
          readonly save: boolean
        },
      ): Effect.Effect<void, ConfigLoadError | ConfigWriteError> =>
        writeUserConfig((current) => {
          const decision = decide(current)
          return Effect.succeed({ ...decision, result: decision.save })
        }).pipe(Effect.asVoid)

      // The project file of `cwd` as it is now: empty outside a project
      // scope, and empty (with its failure) when it does not decode.
      const readProject = Effect.fn("ConfigService.readProject")(function* (cwd: string) {
        const failures: Array<ConfigLoadError> = []
        const files: Array<ConfigFileRead> = []
        let project = new UserConfig({})
        const projectScope = yield* hasProjectScope({ user: home, project: cwd }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        )
        if (projectScope) {
          const projectPath = path.join(cwd, ConfigService.CONFIG_RELATIVE)
          const projectRead = yield* Effect.result(readConfigFile(projectPath))
          if (Result.isFailure(projectRead)) {
            failures.push(projectRead.failure)
            files.push(unreadable(projectRead.failure))
          } else {
            files.push(projectRead.success.file)
            if (Result.isSuccess(projectRead.success.read)) {
              project = projectRead.success.read.success
              yield* warnUserOnlyFields(projectPath, project)
            } else failures.push(projectRead.success.read.failure)
          }
        }
        return { project, failures, files }
      })

      // The user and project files as they are now, merged. A user file that
      // does not decode reads as the last one that did; a project file that
      // does not decode sets nothing. Both are in `failures`, and a turn
      // refuses to run on either: the stand-in can grant more than the file.
      const readUser = Effect.gen(function* () {
        const failures: Array<ConfigLoadError> = []
        const files: Array<ConfigFileRead> = []
        const userRead = yield* readUserConfig
        let user = yield* SynchronizedRef.get(userConfigRef)
        if (Result.isFailure(userRead)) {
          failures.push(userRead.failure)
          files.push(unreadable(userRead.failure))
        } else {
          files.push(userRead.success.file)
          if (Result.isSuccess(userRead.success.read)) user = userRead.success.read.success
          else failures.push(userRead.success.read.failure)
        }
        return { user, failures, files }
      })
      const readFresh = Effect.fn("ConfigService.readFresh")(function* (cwd: string) {
        const { user, failures, files } = yield* readUser
        const projectRead = yield* readProject(cwd)
        failures.push(...projectRead.failures)
        files.push(...projectRead.files)
        const project = projectRead.project
        return {
          config: mergeConfigs(user, project),
          failures,
          files,
          fingerprint: configFilesFingerprint(files),
        }
      })

      const project = (cwd: string) =>
        projectOf(cwd, home).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        )

      const service: ConfigServiceService = {
        get: Effect.fn("ConfigService.get")(function* (cwd) {
          const fresh = yield* readFresh(
            Option.getOrElse(Option.fromUndefinedOr(cwd), () => runtimeEnvironment.cwd),
          )
          return fresh.config
        }),

        getFresh: readFresh,

        project,

        extraUsage: Effect.fn("ConfigService.extraUsage")(function* (owner) {
          const { user } = yield* readUser
          return user.providers?.[owner]?.extraUsage ?? false
        }),

        sabbath: Effect.map(readUser, ({ user }) => Option.fromUndefinedOr(user.sabbath)),

        setDriverOverride: Effect.fn("ConfigService.setDriverOverride")(function* (agent, driver) {
          yield* mutateUserConfig((current) => ({
            updated: configUpdates.setDriverOverride(current, agent, driver),
            save: true,
          }))
        }),

        clearDriverOverride: Effect.fn("ConfigService.clearDriverOverride")(function* (agent) {
          yield* mutateUserConfig((current) =>
            Option.match(configUpdates.clearDriverOverride(current, agent), {
              onNone: () => ({ updated: current, save: false }),
              onSome: (updated) => ({ updated, save: true }),
            }),
          )
        }),

        setModelIfUnset: Effect.fn("ConfigService.setModelIfUnset")(function* (model) {
          yield* mutateUserConfig((current) =>
            Option.match(configUpdates.setModelIfUnset(current, model), {
              onNone: () => ({ updated: current, save: false }),
              onSome: (updated) => ({ updated, save: true }),
            }),
          )
        }),

        setAuthOrder: Effect.fn("ConfigService.setAuthOrder")(
          function* (owner, order, aliases, cwd) {
            const { project } = yield* readProject(cwd)
            const shadowing = shadowingOrderEntries(project, owner, aliases)
            if (shadowing.length > 0) return shadowing
            yield* mutateUserConfig((current) =>
              Option.match(configUpdates.setAuthOrder(current, owner, order, aliases), {
                onNone: () => ({ updated: current, save: false }),
                onSome: (updated) => ({ updated, save: true }),
              }),
            )
            return []
          },
        ),

        renameAuthSlot: (params) =>
          writeUserConfig((current) =>
            Effect.gen(function* () {
              const { project } = yield* readProject(params.cwd)
              const refusal = authSlotRenameRefusal({ ...params, user: current, project })
              if (Option.isSome(refusal)) return { updated: current, save: false, result: refusal }
              yield* params.move
              const renamed = configUpdates.renameAuthSlot(
                current,
                params.owner,
                params.aliases,
                params.from,
                params.to,
              )
              return {
                updated: Option.getOrElse(renamed, () => current),
                save: Option.isSome(renamed),
                result: Option.none<string>(),
              }
            }),
          ).pipe(Effect.withSpan("ConfigService.renameAuthSlot")),
      }

      return service
    }),
  )

  static Test = (initialConfig: UserConfig = new UserConfig({})): Layer.Layer<ConfigService> =>
    Layer.effect(
      ConfigService,
      Effect.gen(function* () {
        // Every write takes the ref's permit, as `Live` writes do.
        const userConfigRef = yield* SynchronizedRef.make(initialConfig)
        // No filesystem, so there is no project config to read: the merge runs
        // against the empty one for its normalizing half.
        const emptyProjectConfig = new UserConfig({})

        return ConfigService.of({
          // Test impl: `cwd` is ignored — no filesystem to read. Tests that
          // need per-cwd behavior should drive it through `Live` with a
          // tmpdir cwd, since `Test` is for hermetic units.
          get: () =>
            Effect.gen(function* () {
              const user = yield* SynchronizedRef.get(userConfigRef)
              return mergeConfigs(user, emptyProjectConfig)
            }),
          getFresh: () =>
            Effect.gen(function* () {
              const user = yield* SynchronizedRef.get(userConfigRef)
              return {
                config: mergeConfigs(user, emptyProjectConfig),
                failures: [],
                // It reads no file, so no file an extension reads can change.
                files: [],
                fingerprint: "test",
              }
            }),
          // No filesystem: a cwd is its own project.
          project: (cwd) => Effect.succeed(cwd),
          extraUsage: (owner) =>
            Effect.map(
              SynchronizedRef.get(userConfigRef),
              (user) => user.providers?.[owner]?.extraUsage ?? false,
            ),
          sabbath: Effect.map(SynchronizedRef.get(userConfigRef), (user) =>
            Option.fromUndefinedOr(user.sabbath),
          ),
          setDriverOverride: (agent, driver) =>
            SynchronizedRef.update(userConfigRef, (current) =>
              configUpdates.setDriverOverride(current, agent, driver),
            ),
          clearDriverOverride: (agent) =>
            SynchronizedRef.update(userConfigRef, (current) =>
              Option.getOrElse(configUpdates.clearDriverOverride(current, agent), () => current),
            ),
          setModelIfUnset: (model) =>
            SynchronizedRef.update(userConfigRef, (current) =>
              Option.getOrElse(configUpdates.setModelIfUnset(current, model), () => current),
            ),
          // No project config to shadow the write.
          setAuthOrder: (owner, order, aliases) =>
            SynchronizedRef.update(userConfigRef, (current) =>
              Option.getOrElse(
                configUpdates.setAuthOrder(current, owner, order, aliases),
                () => current,
              ),
            ).pipe(Effect.as([])),
          // One permit for the check, the move and the rewrite, as `Live` holds.
          renameAuthSlot: (params) =>
            SynchronizedRef.modifyEffect(userConfigRef, (current) =>
              Effect.gen(function* () {
                const refusal = authSlotRenameRefusal({
                  ...params,
                  user: current,
                  project: emptyProjectConfig,
                })
                if (Option.isSome(refusal)) return [refusal, current] as const
                yield* params.move
                const renamed = configUpdates.renameAuthSlot(
                  current,
                  params.owner,
                  params.aliases,
                  params.from,
                  params.to,
                )
                return [Option.none<string>(), Option.getOrElse(renamed, () => current)] as const
              }),
            ),
        })
      }),
    )
}

// ── project trust ───────────────────────────────────────────────────────────

const TrustConfig = Schema.fromJsonString(
  Schema.Struct({ trustedProjects: UserConfig.fields.trustedProjects }),
)

/** Whether `trustedProjects` names the canonical root that owns this project extension directory. */
const isProjectRootTrusted = Effect.fn("ExtensionLoader.projectRootTrust")(function* (
  trustedProjects: ReadonlyArray<string>,
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.realPath(path.resolve(projectDir, "../..")).pipe(
    Effect.map((projectRoot) => trustedProjects.includes(projectRoot)),
    Effect.orElseSucceed(() => false),
  )
})

/** Only user configuration can authorize project module execution. */
export const isProjectExtensionDirectoryTrusted = Effect.fn("ExtensionLoader.projectTrust")(
  function* (directories: { readonly userDir: string; readonly projectDir: string }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const configPath = path.resolve(directories.userDir, "..", GENT_CONFIG_FILENAME)
    const trustedProjects = yield* fs.readFileString(configPath).pipe(
      Effect.flatMap(Schema.decodeEffect(TrustConfig)),
      Effect.map((config) => config.trustedProjects ?? []),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    )
    return yield* isProjectRootTrusted(trustedProjects, directories.projectDir)
  },
)

/**
 * Whether the user config trusts the project `cwd` is in: gent runs outside
 * home, and `trustedProjects` names the project root. A project file whose
 * entries run commands or spend on models (MCP servers, model routers)
 * counts only then.
 */
export const isProjectTrusted = Effect.fn("Config.projectTrusted")(function* (sides: {
  readonly home: string
  readonly cwd: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (!(yield* hasProjectScope({ user: sides.home, project: sides.cwd }))) return false
  const userConfig = path.join(sides.home, GENT_CONFIG_DIRECTORY, GENT_CONFIG_FILENAME)
  const trustedProjects = yield* fs.readFileString(userConfig).pipe(
    Effect.flatMap(Schema.decodeEffect(TrustConfig)),
    Effect.map((config) => config.trustedProjects ?? []),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  )
  return yield* fs.realPath(sides.cwd).pipe(
    Effect.map((root) => trustedProjects.includes(root)),
    Effect.orElseSucceed(() => false),
  )
})
