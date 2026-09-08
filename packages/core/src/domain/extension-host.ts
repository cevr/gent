/**
 * `ExtensionHost` — the one service an extension's `setup` yields.
 *
 * It carries the setup-time facts (cwd, source, home, host facts, process
 * helpers) and the two registration primitives:
 *
 * - `register(domain, ...values)` adds typed leaves to one registration
 *   domain: tools, requests, agents, resources, jobs, model or external drivers.
 * - `on(kind, handler)` adds one runtime hook.
 *
 * The loader provides the service around `GentExtension.setup`, collects the
 * registrations, validates them, and seals them into
 * `LoadedExtension.contributions`. There is no ctx parameter and no bucket
 * literal: authors yield the host inside `setup`.
 *
 * @module
 */
import { Context, Effect } from "effect"
import type { ExtensionContributions } from "./contribution.js"
import {
  hook,
  type AnyExtensionHook,
  type ExtensionHostPlatform,
  type ExtensionHookHandler,
  type ExtensionHookKind,
} from "./extension.js"

/** Author-facing domain name → contribution bucket it lands in. */
export interface RegistrationDomainMap {
  readonly tool: "tools"
  readonly request: "requests"
  readonly agent: "agents"
  readonly resource: "resources"
  readonly job: "scheduledJobs"
  readonly modelDriver: "modelDrivers"
  readonly externalDriver: "externalDrivers"
}

export const registrationDomains: RegistrationDomainMap = {
  tool: "tools",
  request: "requests",
  agent: "agents",
  resource: "resources",
  job: "scheduledJobs",
  modelDriver: "modelDrivers",
  externalDriver: "externalDrivers",
}

export type RegistrationDomain = keyof typeof registrationDomains
type BucketOf<D extends RegistrationDomain> = RegistrationDomainMap[D]
type ElementOf<A> = A extends ReadonlyArray<infer Item> ? Item : never
export type RegistrationValue<D extends RegistrationDomain> = ElementOf<
  NonNullable<ExtensionContributions[BucketOf<D>]>
>

export interface ExtensionHostService {
  readonly cwd: string
  readonly source: string
  readonly home: string
  readonly host: Pick<
    ExtensionHostPlatform,
    "osInfo" | "execPath" | "homeDirectory" | "pathListSeparator"
  >
  readonly Process: Pick<
    ExtensionHostPlatform,
    "parentEnv" | "runProcess" | "signalPid" | "isPortFree" | "isPidAlive" | "commandCandidates"
  >
  /** Registers leaves in one typed domain. Order within a domain is kept. */
  readonly register: <D extends RegistrationDomain>(
    domain: D,
    ...values: ReadonlyArray<RegistrationValue<D>>
  ) => Effect.Effect<void>
  /** Registers one runtime hook. Author error and service channels are sealed by the runtime. */
  readonly on: <K extends ExtensionHookKind, E = never, R = never>(
    kind: K,
    handler: ExtensionHookHandler<K, E, R>,
  ) => Effect.Effect<void>
}

export class ExtensionHost extends Context.Service<ExtensionHost, ExtensionHostService>()(
  "@gent/core/src/domain/extension-host/ExtensionHost",
) {}

export interface ExtensionHostFacts {
  readonly cwd: string
  readonly source: string
  readonly home: string
  readonly host: ExtensionHostPlatform
}

type MutableContributions = {
  -readonly [K in keyof ExtensionContributions]?: Array<
    ElementOf<NonNullable<ExtensionContributions[K]>>
  >
}

/**
 * A host whose registrations accumulate into one contributions record.
 * `seal` returns the record with empty buckets dropped.
 */
export interface CollectingExtensionHost {
  readonly service: ExtensionHostService
  readonly seal: Effect.Effect<ExtensionContributions>
}

export const makeCollectingExtensionHost = (facts: ExtensionHostFacts): CollectingExtensionHost => {
  const collected: MutableContributions = {}
  const push = <K extends keyof ExtensionContributions>(
    bucket: K,
    values: ReadonlyArray<ElementOf<NonNullable<ExtensionContributions[K]>>>,
  ) => {
    if (values.length === 0) return
    const current = collected[bucket] ?? []
    // The bucket arrays are homogeneous by construction; TypeScript loses the
    // correlation between `bucket` and its element type across the index.
    // oxlint-disable-next-line effect/noAs, typescript/no-unsafe-type-assertion -- Correlated bucket/element pair is guaranteed by the K parameter.
    collected[bucket] = [...current, ...values] as MutableContributions[K]
  }
  const service: ExtensionHostService = {
    cwd: facts.cwd,
    source: facts.source,
    home: facts.home,
    host: {
      osInfo: facts.host.osInfo,
      execPath: facts.host.execPath,
      homeDirectory: facts.host.homeDirectory,
      pathListSeparator: facts.host.pathListSeparator,
    },
    Process: {
      parentEnv: facts.host.parentEnv,
      runProcess: facts.host.runProcess,
      signalPid: facts.host.signalPid,
      isPortFree: facts.host.isPortFree,
      isPidAlive: facts.host.isPidAlive,
      commandCandidates: facts.host.commandCandidates,
    },
    register: (domain, ...values) =>
      Effect.sync(() => {
        push(registrationDomains[domain], values)
      }),
    on: (kind, handler) =>
      Effect.sync(() => {
        push("hooks", [hook(kind, handler)])
      }),
  }
  // `push` replaces bucket arrays instead of mutating them, so a shallow copy
  // is a stable snapshot; empty buckets never enter `collected`.
  return { service, seal: Effect.sync((): ExtensionContributions => ({ ...collected })) }
}

/** Re-registers one compiled slot; the switch restores the kind/handler correlation. */
const replayHook = (host: ExtensionHostService, slot: AnyExtensionHook): Effect.Effect<void> => {
  switch (slot.kind) {
    case "systemPrompt":
      return host.on(slot.kind, slot.hook.handler)
    case "turnProjection":
      return host.on(slot.kind, slot.hook.handler)
    case "turnAfter":
      return host.on(slot.kind, slot.hook.handler)
    case "toolCall":
      return host.on(slot.kind, slot.hook.handler)
    case "toolResult":
      return host.on(slot.kind, slot.hook.handler)
  }
}

/** Re-registers an already compiled record; used by test harnesses that wrap loaded extensions. */
export const registerContributions = (contributions: ExtensionContributions) =>
  Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", ...(contributions.resources ?? []))
    yield* host.register("job", ...(contributions.scheduledJobs ?? []))
    yield* host.register("tool", ...(contributions.tools ?? []))
    yield* host.register("request", ...(contributions.requests ?? []))
    yield* host.register("agent", ...(contributions.agents ?? []))
    yield* host.register("modelDriver", ...(contributions.modelDrivers ?? []))
    yield* host.register("externalDriver", ...(contributions.externalDrivers ?? []))
    for (const slot of contributions.hooks ?? []) yield* replayHook(host, slot)
  })
