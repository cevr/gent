/**
 * Live runtime profile ownership.
 *
 * Declarations are loaded before the graph host is changed. The host owns
 * process resources and publication scopes. This module only stages the
 * immutable profile catalog from the context already acquired by that host.
 *
 * @module
 */

import { Effect, FileSystem, Option, Path, Predicate, Result, Schema } from "effect"
import type { Context } from "effect"
import { canonicalJsonString } from "effect-encore"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { GentPlatform, type GentPlatformApi } from "./gent-platform.js"
import type { DriverRef } from "../domain/agent.js"
import { getToolMetadata } from "../domain/capability/tool.js"
import type { PermissionRule } from "../domain/permission.js"
import type { PromptSection } from "../domain/prompt.js"
import {
  ResourceDescriptor,
  ResourceRevision,
  planResourceGraph,
  type ResourcePlan,
} from "../domain/resource-graph.js"
import type { AnyResourceContribution } from "../domain/resource.js"
import {
  ResourceGraphExtensionSource,
  ResourceGraphRevision,
  ResourceGraphSnapshot,
  ResourceGraphSource,
  type ResourceGraphSnapshot as ResourceGraphSnapshotType,
} from "../domain/resource-graph-state.js"
import { collectResourceEntries } from "./extensions/resource-host/resource-layer.js"
import {
  makeResourceGraphHost,
  type ResourceGraphHost,
  ResourceGraphFailure,
  ResourceGraphHostError,
  type ResourceGraphRetireMode,
  type ResourceGraphPublication,
} from "./extensions/resource-host/resource-graph-host.js"
import {
  buildProfileCatalog,
  loadRuntimeProfileDeclarations,
  type RuntimeProfile,
  type RuntimeProfileDeclarations,
  type RuntimeProfileCatalog,
  type RuntimeProfileInputs,
} from "./profile.js"
import {
  type ConfigLoadError,
  ConfigService,
  type ConfigServiceService,
  UserConfig,
} from "./config-service.js"
import {
  reconcileScheduledJobs,
  type CronRuntimeApi,
  type SchedulerFailure,
} from "./extensions/resource-host/schedule-engine.js"
import { resolveExtensions } from "./extensions/registry.js"
import {
  ResourceGraphApplyError,
  type ResourceGraphDesiredApplication,
  type ResourceGraphPrepared,
} from "./extensions/resource-host/resource-graph-entity.js"
import { extensionKey } from "./extensions/activation.js"

export interface LiveRuntimeProfile {
  readonly profile: RuntimeProfile
  readonly publication: ResourceGraphPublication<RuntimeProfileCatalog>
  readonly desired: RuntimeProfileDesiredState
}

/** Runtime values retained by one owner for exact desired-snapshot replay. */
export interface RuntimeProfileDesiredState {
  readonly snapshot: ResourceGraphSnapshotType
  readonly config: UserConfig
  readonly declarations: RuntimeProfileDeclarations
  readonly resources: ReadonlyArray<AnyResourceContribution>
  readonly inputs: RuntimeProfileInputs
}

export interface RuntimeProfilePreparedDesired extends ResourceGraphPrepared {
  readonly owner: RuntimeProfileOwner
  readonly desired: RuntimeProfileDesiredState
  readonly config: UserConfig
  readonly publicationRevision: ResourceRevision
}

export const isRuntimeProfilePreparedDesired = (
  prepared: ResourceGraphPrepared,
): prepared is RuntimeProfilePreparedDesired => "owner" in prepared

export interface RuntimeProfileOwner {
  readonly refresh: (
    inputs: RuntimeProfileInputs,
    retireMode?: ResourceGraphRetireMode,
  ) => Effect.Effect<LiveRuntimeProfile, ConfigLoadError | ResourceGraphHostError>
  /** Load the current declarations without publishing or acquiring resources. */
  readonly preview: (
    inputs: RuntimeProfileInputs,
  ) => Effect.Effect<ResourceGraphSnapshotType, ResourceGraphApplyError>
  readonly current: Effect.Effect<Option.Option<LiveRuntimeProfile>>
  readonly prepareDesired: (
    request: ResourceGraphDesiredApplication,
    inputs: RuntimeProfileInputs,
  ) => Effect.Effect<RuntimeProfilePreparedDesired, ResourceGraphApplyError>
  readonly validateDesired: (
    prepared: RuntimeProfilePreparedDesired,
  ) => Effect.Effect<void, ResourceGraphApplyError>
  readonly applyDesired: (
    prepared: RuntimeProfilePreparedDesired,
    admit: () => Effect.Effect<void, ResourceGraphApplyError>,
  ) => Effect.Effect<void, ResourceGraphApplyError>
}

// oxlint-disable-next-line effect/noUnknownParameters -- The explicit revision projection is parsed as JSON before hashing.
const stableJsonValue = (value: unknown): string =>
  canonicalJsonString(Schema.decodeUnknownSync(Schema.Json)(value))

// oxlint-disable-next-line effect/noNullish -- JSON revision descriptors use null for an absent optional field.
const absentJson: Schema.Json = null

const optionalString = (value: Option.Option<string>): Schema.Json =>
  Option.getOrElse(value, () => absentJson)

const optionalBoolean = (value: Option.Option<boolean>): Schema.Json =>
  Option.getOrElse(value, () => absentJson)

const optionalNumber = (value: Option.Option<number>): Schema.Json =>
  Option.getOrElse(value, () => absentJson)

const optionalStringArray = (value: Option.Option<ReadonlyArray<string>>): Schema.Json =>
  Option.match(value, {
    onNone: () => [],
    onSome: (items) => [...items],
  })

const promptDescriptor = (prompt: Option.Option<PromptSection>): Schema.Json =>
  Option.match(prompt, {
    onNone: () => absentJson,
    onSome: (value) => ({ id: value.id, content: value.content, priority: value.priority }),
  })

const permissionRuleDescriptor = (rule: PermissionRule): Schema.Json => ({
  tool: rule.tool,
  action: rule.action,
  pattern: optionalString(Option.fromUndefinedOr(rule.pattern)),
})

const permissionRulesDescriptor = (
  rules: Option.Option<ReadonlyArray<PermissionRule>>,
): Schema.Json =>
  Option.match(rules, {
    onNone: () => [],
    onSome: (items) => items.map(permissionRuleDescriptor),
  })

const driverRefDescriptor = (driver: Option.Option<DriverRef>): Schema.Json =>
  Option.match(driver, {
    onNone: () => absentJson,
    onSome: (value) => {
      if (value._tag === "model") {
        return { _tag: value._tag, id: optionalString(Option.fromUndefinedOr(value.id)) }
      }
      return { _tag: value._tag, id: value.id }
    },
  })

const driverOverridesDescriptor = (
  overrides: Option.Option<Readonly<Record<string, DriverRef>>>,
): Schema.Json => {
  const result: Record<string, Schema.Json> = {}
  const entries = Option.getOrElse(overrides, () => ({}))
  for (const [agent, driver] of Object.entries(entries)) {
    result[agent] = driverRefDescriptor(Option.some(driver))
  }
  return result
}

const stringRecordDescriptor = (
  values: Option.Option<Readonly<Record<string, string>>>,
): Schema.Json => {
  const result: Record<string, Schema.Json> = {}
  const entries = Option.getOrElse(values, () => ({}))
  for (const [key, value] of Object.entries(entries)) result[key] = value
  return result
}

const schemaDescriptor = (schema: Schema.Top): Schema.Json =>
  Schema.decodeUnknownSync(Schema.Json)(Schema.toJsonSchemaDocument(schema))

const extensionDescriptor = (extension: RuntimeProfile["resolved"]["extensions"][number]) => ({
  id: extension.manifest.id,
  version: optionalString(Option.fromUndefinedOr(extension.manifest.version)),
  artifactIdentity: optionalString(Option.fromUndefinedOr(extension.artifactIdentity)),
  scope: extension.scope,
  sourcePath: extension.sourcePath,
  resources: (extension.contributions.resources ?? []).map((resource) => ({
    id: resource.id,
    revision: resource.revision,
    requires: [...resource.requires].sort(),
    required: resource.required,
  })),
  scheduledJobs: (extension.contributions.scheduledJobs ?? []).map((job) => ({
    id: job.id,
    cron: job.cron,
    target: {
      agent: job.target.agent,
      prompt: job.target.prompt,
      cwd: optionalString(Option.fromUndefinedOr(job.target.cwd)),
    },
  })),
  tools: (extension.contributions.tools ?? []).map((tool) => {
    const metadata = getToolMetadata(tool)
    return {
      id: metadata.id,
      readonly: metadata.readonly,
      promptSnippet: optionalString(Option.fromUndefinedOr(metadata.promptSnippet)),
      promptGuidelines: optionalStringArray(Option.fromUndefinedOr(metadata.promptGuidelines)),
      interactive: optionalBoolean(Option.fromUndefinedOr(metadata.interactive)),
      permissionRules: permissionRulesDescriptor(Option.fromUndefinedOr(metadata.permissionRules)),
      prompt: promptDescriptor(Option.fromUndefinedOr(metadata.prompt)),
      input: schemaDescriptor(metadata.input),
      output: schemaDescriptor(metadata.output),
    }
  }),
  requests: (extension.contributions.requests ?? []).map((request) => ({
    id: request.id,
    description: optionalString(Option.fromUndefinedOr(request.description)),
    prompt: promptDescriptor(Option.fromUndefinedOr(request.prompt)),
    slash: Option.match(Option.fromUndefinedOr(request.slash), {
      onNone: () => absentJson,
      onSome: (slash) => ({
        trigger: optionalString(Option.fromUndefinedOr(slash.trigger)),
        name: optionalString(Option.fromUndefinedOr(slash.name)),
        description: optionalString(Option.fromUndefinedOr(slash.description)),
        category: optionalString(Option.fromUndefinedOr(slash.category)),
        keybind: optionalString(Option.fromUndefinedOr(slash.keybind)),
      }),
    }),
    input: schemaDescriptor(request.input),
    output: schemaDescriptor(request.output),
  })),
  agents: (extension.contributions.agents ?? []).map((agent) => ({
    name: agent.name,
    description: optionalString(Option.fromUndefinedOr(agent.description)),
    model: optionalString(Option.fromUndefinedOr(agent.model)),
    systemPromptAddendum: optionalString(Option.fromUndefinedOr(agent.systemPromptAddendum)),
    allowedTools: optionalStringArray(Option.fromUndefinedOr(agent.allowedTools)),
    deniedTools: optionalStringArray(Option.fromUndefinedOr(agent.deniedTools)),
    temperature: optionalNumber(Option.fromUndefinedOr(agent.temperature)),
    reasoningEffort: optionalString(Option.fromUndefinedOr(agent.reasoningEffort)),
    driver: driverRefDescriptor(Option.fromUndefinedOr(agent.driver)),
  })),
  modelDrivers: (extension.contributions.modelDrivers ?? []).map((driver) => ({
    id: driver.id,
    name: driver.name,
    authMethods: Option.match(Option.fromUndefinedOr(driver.auth), {
      onNone: () => [],
      onSome: (auth) => auth.methods.map((method) => ({ type: method.type, label: method.label })),
    }),
  })),
  externalDrivers: (extension.contributions.externalDrivers ?? []).map((driver) => ({
    id: driver.id,
    toolSurface: optionalString(Option.fromUndefinedOr(driver.toolSurface)),
  })),
  hooks: (extension.contributions.hooks ?? []).map((hook) => hook.kind),
})

const profileRevision = (
  platform: { readonly hash: (algorithm: "sha256", input: string) => string },
  inputs: RuntimeProfileInputs,
  config: UserConfig,
  profile: RuntimeProfile,
): ResourceRevision =>
  ResourceRevision.make(
    `profile:${platform.hash(
      "sha256",
      stableJsonValue({
        inputs: {
          cwd: profile.cwd,
          home: inputs.home,
          platform: inputs.platform,
          shell: optionalString(Option.fromUndefinedOr(inputs.shell)),
          osVersion: optionalString(Option.fromUndefinedOr(inputs.osVersion)),
          disabledExtensions: optionalStringArray(
            Option.fromUndefinedOr(inputs.disabledExtensions),
          ),
          scheduledJobCommand: optionalStringArray(
            Option.fromUndefinedOr(inputs.scheduledJobCommand),
          ),
          scheduledJobEnv: stringRecordDescriptor(Option.fromUndefinedOr(inputs.scheduledJobEnv)),
        },
        config: {
          permissions: permissionRulesDescriptor(Option.fromUndefinedOr(config.permissions)),
          disabledExtensions: optionalStringArray(
            Option.fromUndefinedOr(config.disabledExtensions),
          ),
          driverOverrides: driverOverridesDescriptor(
            Option.fromUndefinedOr(config.driverOverrides),
          ),
        },
        declarations: profile.resolved.extensions.map(extensionDescriptor),
        failures: profile.resolved.failedExtensions.map((failure) => ({
          manifest: {
            id: failure.manifest.id,
            version: optionalString(Option.fromUndefinedOr(failure.manifest.version)),
          },
          scope: failure.scope,
          sourcePath: failure.sourcePath,
          phase: failure.phase,
          error: failure.error,
        })),
        instructions: profile.instructions,
        sections: profile.coreSections.map((section) => ({
          id: section.id,
          content: section.content,
          priority: section.priority,
        })),
        extensionSections: profile.extensionSectionInputs.map((section) => ({
          id: section.id,
          content: section.content,
          priority: section.priority,
        })),
      }),
    )}`,
  )

const scheduledFailuresByExtension = (failures: ReadonlyArray<SchedulerFailure>) => {
  const grouped = new Map<string, Array<{ readonly jobId: string; readonly error: string }>>()
  for (const failure of failures) {
    const current = grouped.get(failure.extensionId) ?? []
    current.push({ jobId: failure.jobId, error: failure.error })
    grouped.set(failure.extensionId, current)
  }
  return grouped
}

const runtimeProfileFromDeclarations = (params: {
  readonly declarations: RuntimeProfileDeclarations
  readonly scheduledJobFailures: ReadonlyArray<{
    readonly extensionId: SchedulerFailure["extensionId"]
    readonly jobId: SchedulerFailure["jobId"]
    readonly error: SchedulerFailure["error"]
  }>
}): RuntimeProfile => {
  const scheduledJobFailures = params.scheduledJobFailures
  const resolved = resolveExtensions(
    params.declarations.extensionDeclarations.active,
    params.declarations.extensionDeclarations.failed,
    scheduledFailuresByExtension(scheduledJobFailures),
  )
  return {
    cwd: params.declarations.cwd,
    resolved,
    // The live host owns the resource context. Legacy callers that need the
    // old per-extension shape still use resolveRuntimeProfile/buildProfileRuntime.
    resourceContexts: [],
    coreSections: params.declarations.coreSections,
    extensionSectionInputs: [...resolved.promptSections.values()],
    instructions: params.declarations.instructions,
    scheduledJobFailures,
  }
}

/**
 * Keep staged capabilities aligned with graph availability.
 *
 * The author API declares requirements on resources, not on individual
 * capability leaves. Suspend the whole owner when one of its process
 * resources is inactive. This is conservative, but it prevents tools,
 * requests, drivers, and schedules from outliving a service that they may
 * require. The desired declarations remain unchanged for the next plan.
 */
const stageableDeclarations = (
  declarations: RuntimeProfileDeclarations,
  plan: ResourcePlan,
): RuntimeProfileDeclarations => {
  if (plan.inactive.length === 0) return declarations

  const inactiveIds = new Set(plan.inactive.map(({ id }) => id))
  const suspendedOwners = new Set(
    declarations.extensionDeclarations.active.flatMap((extension) => {
      const ownsUnavailableResource = (extension.contributions.resources ?? []).some(
        (resource) => resource.scope === "process" && inactiveIds.has(resource.id),
      )
      if (ownsUnavailableResource) return [extensionKey(extension)]
      return []
    }),
  )
  if (suspendedOwners.size === 0) return declarations

  return {
    ...declarations,
    extensionDeclarations: {
      ...declarations.extensionDeclarations,
      active: declarations.extensionDeclarations.active.filter(
        (extension) => !suspendedOwners.has(extensionKey(extension)),
      ),
    },
  }
}

const effectiveInputs = (
  inputs: RuntimeProfileInputs,
  config: UserConfig,
): RuntimeProfileInputs => {
  const configDisabled = Option.getOrElse(
    Option.fromUndefinedOr(config.disabledExtensions),
    () => [],
  )
  const explicitDisabled = Option.getOrElse(
    Option.fromUndefinedOr(inputs.disabledExtensions),
    () => [],
  )
  return {
    ...inputs,
    config,
    disabledExtensions: [...explicitDisabled, ...configDisabled],
  }
}

const configSnapshot = (config: UserConfig): Schema.Json => {
  const result: Record<string, Schema.Json> = {}
  if (!Predicate.isUndefined(config.permissions)) {
    result["permissions"] = config.permissions.map((rule) => ({
      tool: rule.tool,
      action: rule.action,
      pattern: optionalString(Option.fromUndefinedOr(rule.pattern)),
    }))
  }
  if (!Predicate.isUndefined(config.disabledExtensions)) {
    result["disabledExtensions"] = [...config.disabledExtensions]
  }
  if (!Predicate.isUndefined(config.driverOverrides)) {
    const overrides: Record<string, Schema.Json> = {}
    for (const [agent, driver] of Object.entries(config.driverOverrides)) {
      if (driver._tag === "model") {
        overrides[agent] = {
          _tag: driver._tag,
          id: optionalString(Option.fromUndefinedOr(driver.id)),
        }
      } else {
        overrides[agent] = { _tag: driver._tag, id: driver.id }
      }
    }
    result["driverOverrides"] = overrides
  }
  return result
}

/**
 * The loader must supply an explicit artifact identity. Missing identity is
 * represented as restart-required and cannot be accepted for durable replay.
 * This avoids assigning a new digest to a cached module closure.
 */
const sourceIdentity = (extension: RuntimeProfile["resolved"]["extensions"][number]): string => {
  const artifact = Option.fromUndefinedOr(extension.artifactIdentity)
  if (Option.isSome(artifact)) {
    return [
      "artifact",
      artifact.value,
      extension.scope,
      extension.sourcePath,
      extension.manifest.id,
    ].join(":")
  }
  return ["restart-required", extension.scope, extension.sourcePath, extension.manifest.id].join(
    ":",
  )
}

const makeRuntimeProfileSnapshot = (params: {
  readonly sourceRevision: ResourceRevision
  readonly config: UserConfig
  readonly declarations: RuntimeProfileDeclarations
  readonly resources: ReadonlyArray<AnyResourceContribution>
}): ResourceGraphSnapshot => {
  const extensions = params.declarations.extensionDeclarations.active.map((extension) => {
    const version = extension.manifest.version
    const sourceBase = {
      extensionId: extension.manifest.id,
      scope: extension.scope,
      source: sourceIdentity(extension),
    }
    let source = ResourceGraphExtensionSource.make(sourceBase)
    if (!Predicate.isUndefined(version)) {
      source = ResourceGraphExtensionSource.make({ ...sourceBase, version })
    }
    return source
  })
  const descriptors = params.resources.map((resource) =>
    ResourceDescriptor.make({
      id: resource.id,
      revision: resource.revision,
      requires: [...resource.requires],
      required: resource.required,
    }),
  )
  return ResourceGraphSnapshot.make({
    source: ResourceGraphSource.make({
      revision: ResourceGraphRevision.make(String(params.sourceRevision)),
      config: configSnapshot(params.config),
      extensions,
    }),
    descriptors,
  })
}

const sameSnapshotPart = <A>(left: A, right: A): boolean =>
  stableJsonValue(left) === stableJsonValue(right)

const applyError = (phase: "prepare" | "validate" | "apply", message: string) =>
  new ResourceGraphApplyError({ phase, message })

const decodeSnapshotConfig = (
  snapshot: ResourceGraphSnapshot,
): Effect.Effect<UserConfig, ResourceGraphApplyError> =>
  Effect.fromOption(Schema.decodeUnknownOption(UserConfig)(snapshot.source.config), () =>
    applyError("prepare", "Desired resource graph contains an invalid configuration snapshot"),
  )

/**
 * Create one owner for one cache key. Each refresh validates config and loads
 * declarations before calling the host, so a bad desired config cannot retire
 * the currently published generation.
 */
export const makeRuntimeProfileOwner = (params: {
  readonly host: ResourceGraphHost<RuntimeProfileCatalog>
  readonly configService: ConfigServiceService
  readonly fileSystem: FileSystem.FileSystem
  readonly path: Path.Path
  readonly platform: GentPlatformApi
  readonly childProcessSpawner: ChildProcessSpawner["Service"]
  readonly schedulerRuntime?: CronRuntimeApi
}) => {
  let latestDesired = Option.none<RuntimeProfileDesiredState>()

  const loadDesired = (inputs: RuntimeProfileInputs, config: UserConfig) =>
    Effect.gen(function* () {
      const declarations = yield* loadRuntimeProfileDeclarations(
        effectiveInputs(inputs, config),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, params.fileSystem),
        Effect.provideService(Path.Path, params.path),
        Effect.provideService(ChildProcessSpawner, params.childProcessSpawner),
        Effect.provideService(ConfigService, params.configService),
        Effect.provideService(GentPlatform, params.platform),
      )
      const resources = collectResourceEntries(
        declarations.extensionDeclarations.active,
        "process",
      ).map(({ resource }) => resource)
      const profile = runtimeProfileFromDeclarations({ declarations, scheduledJobFailures: [] })
      const revision = profileRevision(
        params.platform,
        effectiveInputs(inputs, config),
        config,
        profile,
      )
      const snapshot = makeRuntimeProfileSnapshot({
        sourceRevision: revision,
        config,
        declarations,
        resources,
      })
      return {
        snapshot,
        config,
        declarations,
        resources,
        inputs: effectiveInputs(inputs, config),
      } satisfies RuntimeProfileDesiredState
    })

  const stageCatalog =
    (config: UserConfig, inputs: RuntimeProfileInputs) =>
    (stageInput: {
      readonly payload: RuntimeProfileDeclarations
      readonly plan: ResourcePlan
      readonly context: Context.Context<unknown>
    }) =>
      Effect.gen(function* () {
        const declarations = stageableDeclarations(stageInput.payload, stageInput.plan)
        const scheduledJobFailures = yield* reconcileScheduledJobs({
          extensions: declarations.extensionDeclarations.active,
          home: inputs.home,
          command: inputs.scheduledJobCommand,
          env: inputs.scheduledJobEnv,
          runtime: params.schedulerRuntime,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, params.fileSystem),
          Effect.provideService(Path.Path, params.path),
        )
        const profile = runtimeProfileFromDeclarations({
          declarations,
          scheduledJobFailures,
        })
        return yield* buildProfileCatalog({
          profile,
          configService: params.configService,
          resourceContext: stageInput.context,
          configOverride: config,
        })
      })

  const refresh = (inputs: RuntimeProfileInputs, retireMode: ResourceGraphRetireMode = "drain") =>
    Effect.gen(function* () {
      const config = yield* params.configService.getFresh(inputs.cwd)
      const desired = yield* loadDesired(inputs, config)
      const publication = yield* params.host.apply({
        publicationRevision: ResourceRevision.make(String(desired.snapshot.source.revision)),
        payload: desired.declarations,
        retireMode,
        resources: desired.resources,
        stage: stageCatalog(desired.config, desired.inputs),
      })
      latestDesired = Option.some(desired)
      return {
        profile: publication.value.profile,
        publication,
        desired,
      } satisfies LiveRuntimeProfile
    })

  const preview: RuntimeProfileOwner["preview"] = (inputs) =>
    Effect.gen(function* () {
      const config = yield* params.configService
        .getFresh(inputs.cwd)
        .pipe(
          Effect.mapError((error) =>
            applyError("prepare", `Could not load profile configuration: ${String(error)}`),
          ),
        )
      const desired = yield* loadDesired(inputs, config).pipe(
        Effect.mapError((error) =>
          applyError("prepare", `Could not load desired declarations: ${String(error)}`),
        ),
      )
      return desired.snapshot
    })

  const current: RuntimeProfileOwner["current"] = params.host.current.pipe(
    Effect.map((publication) => {
      if (Option.isNone(publication) || Option.isNone(latestDesired)) {
        return Option.none<LiveRuntimeProfile>()
      }
      return Option.some({
        profile: publication.value.value.profile,
        publication: publication.value,
        desired: latestDesired.value,
      })
    }),
  )

  let owner: RuntimeProfileOwner

  const prepareDesired: RuntimeProfileOwner["prepareDesired"] = (request, inputs) =>
    Effect.gen(function* () {
      if (
        request.snapshot.source.extensions.some((extension) =>
          extension.source.startsWith("restart-required:"),
        )
      ) {
        return yield* new ResourceGraphApplyError({
          phase: "prepare",
          message:
            "Desired resource graph requires a stable loaded artifact identity before replay",
        })
      }
      const config = yield* decodeSnapshotConfig(request.snapshot)
      const desired = yield* loadDesired(inputs, config).pipe(
        Effect.mapError((error) =>
          applyError("prepare", `Could not load desired declarations: ${String(error)}`),
        ),
      )
      if (
        !sameSnapshotPart(request.snapshot.source.extensions, desired.snapshot.source.extensions)
      ) {
        return yield* new ResourceGraphApplyError({
          phase: "prepare",
          message: "Desired resource graph does not match the loaded extension artifact identity",
        })
      }
      if (request.snapshot.source.revision !== desired.snapshot.source.revision) {
        return yield* new ResourceGraphApplyError({
          phase: "prepare",
          message:
            "Desired resource graph source revision does not match the loaded configuration and declarations",
        })
      }
      if (!sameSnapshotPart(request.snapshot.descriptors, desired.snapshot.descriptors)) {
        return yield* new ResourceGraphApplyError({
          phase: "prepare",
          message: "Desired resource graph does not match the loaded resource declarations",
        })
      }
      return {
        request,
        owner,
        desired: {
          ...desired,
          snapshot: request.snapshot,
          config,
        },
        config,
        publicationRevision: ResourceRevision.make(String(desired.snapshot.source.revision)),
      }
    })

  const validateDesired: RuntimeProfileOwner["validateDesired"] = (prepared) =>
    Effect.gen(function* () {
      const planned = planResourceGraph(prepared.request.snapshot.descriptors)
      if (Result.isFailure(planned)) {
        return yield* new ResourceGraphApplyError({
          phase: "validate",
          message: `Invalid desired resource graph: ${String(planned.failure)}`,
        })
      }
      if (
        !sameSnapshotPart(
          prepared.request.snapshot.source.extensions,
          prepared.desired.snapshot.source.extensions,
        ) ||
        !sameSnapshotPart(
          prepared.request.snapshot.descriptors,
          prepared.desired.snapshot.descriptors,
        )
      ) {
        return yield* new ResourceGraphApplyError({
          phase: "validate",
          message: "Loaded declarations changed before desired graph validation",
        })
      }
      return yield* Effect.void
    })

  const toHostAdmission = (
    admit: () => Effect.Effect<void, ResourceGraphApplyError>,
  ): Effect.Effect<void, ResourceGraphHostError> =>
    admit().pipe(
      Effect.mapError(
        (error) =>
          new ResourceGraphHostError({
            failures: [
              ResourceGraphFailure.make({
                // oxlint-disable-next-line effect/noNullish -- Admission failures have no resource owner.
                id: null,
                phase: "validate",
                message: error.message,
              }),
            ],
            retained: [],
            unavailable: [],
          }),
      ),
    )

  const applyDesired: RuntimeProfileOwner["applyDesired"] = (prepared, admit) =>
    params.host
      .apply({
        publicationRevision: prepared.publicationRevision,
        payload: prepared.desired.declarations,
        retireMode: "drain",
        resources: prepared.desired.resources,
        admit: toHostAdmission(admit),
        stage: stageCatalog(prepared.config, prepared.desired.inputs),
      })
      .pipe(
        Effect.tap((publication) =>
          Effect.sync(() => {
            latestDesired = Option.some({
              ...prepared.desired,
              snapshot: prepared.request.snapshot,
              config: prepared.config,
            })
            return publication
          }),
        ),
        Effect.asVoid,
        Effect.mapError((error) =>
          applyError("apply", error.failures.map((failure) => failure.message).join("\n")),
        ),
      )

  owner = {
    refresh,
    preview,
    current,
    prepareDesired,
    validateDesired,
    applyDesired,
  }
  return owner
}

/** Construct a graph host for one profile cache key. */
export const makeRuntimeProfileOwnerHost = (params: {
  readonly baseContext: Context.Context<unknown>
}) => makeResourceGraphHost<RuntimeProfileCatalog>(params)
