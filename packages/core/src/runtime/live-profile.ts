/**
 * Live runtime profile ownership.
 *
 * Declarations are loaded before the graph host is changed. The host owns
 * process resources and publication scopes. This module only stages the
 * immutable profile catalog from the context already acquired by that host.
 *
 * @module
 */

import { Effect, FileSystem, Option, Path, Schema } from "effect"
import type { Context } from "effect"
import { canonicalJsonString } from "effect-encore"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { GentPlatform, type GentPlatformApi } from "./gent-platform.js"
import type { DriverRef } from "../domain/agent.js"
import { getToolMetadata } from "../domain/capability/tool.js"
import type { PermissionRule } from "../domain/permission.js"
import type { PromptSection } from "../domain/prompt.js"
import { ResourceRevision, type ResourcePlan } from "../domain/resource-graph.js"
import type { AnyResourceContribution } from "../domain/resource.js"
import { collectResourceEntries } from "./extensions/resource-host/resource-layer.js"
import {
  makeResourceGraphHost,
  type ResourceGraphHost,
  type ResourceGraphHostError,
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
  type UserConfig,
} from "./config-service.js"
import { resolveExtensions } from "./extensions/registry.js"
import { extensionKey } from "./extensions/activation.js"
import { ProcessRunner } from "../utils/run-process.js"

export interface LiveRuntimeProfile {
  readonly profile: RuntimeProfile
  readonly publication: ResourceGraphPublication<RuntimeProfileCatalog>
  readonly desired: RuntimeProfileDesiredState
}

/** Runtime values retained by one owner for the next refresh. */
interface RuntimeProfileDesiredState {
  readonly revision: ResourceRevision
  readonly config: UserConfig
  readonly declarations: RuntimeProfileDeclarations
  readonly resources: ReadonlyArray<AnyResourceContribution>
  readonly inputs: RuntimeProfileInputs
}

export interface RuntimeProfileOwner {
  readonly refresh: (
    inputs: RuntimeProfileInputs,
    retireMode?: ResourceGraphRetireMode,
  ) => Effect.Effect<LiveRuntimeProfile, ConfigLoadError | ResourceGraphHostError>
  readonly current: Effect.Effect<Option.Option<LiveRuntimeProfile>>
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

const runtimeProfileFromDeclarations = (
  declarations: RuntimeProfileDeclarations,
): RuntimeProfile => {
  const resolved = resolveExtensions(
    declarations.extensionDeclarations.active,
    declarations.extensionDeclarations.failed,
  )
  return {
    cwd: declarations.cwd,
    resolved,
    coreSections: declarations.coreSections,
    extensionSectionInputs: [...resolved.promptSections.values()],
    instructions: declarations.instructions,
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
  readonly processRunner: ProcessRunner["Service"]
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
        Effect.provideService(ProcessRunner, params.processRunner),
      )
      const resources = collectResourceEntries(declarations.resolved.extensions, "process").map(
        ({ resource }) => resource,
      )
      const profile = runtimeProfileFromDeclarations(declarations)
      const revision = profileRevision(
        params.platform,
        effectiveInputs(inputs, config),
        config,
        profile,
      )
      return {
        revision,
        config,
        declarations,
        resources,
        inputs: effectiveInputs(inputs, config),
      } satisfies RuntimeProfileDesiredState
    })

  const stageCatalog =
    (config: UserConfig) =>
    (stageInput: {
      readonly payload: RuntimeProfileDeclarations
      readonly plan: ResourcePlan
      readonly context: Context.Context<unknown>
    }) =>
      Effect.gen(function* () {
        const declarations = stageableDeclarations(stageInput.payload, stageInput.plan)
        const profile = runtimeProfileFromDeclarations(declarations)
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
        publicationRevision: desired.revision,
        payload: desired.declarations,
        retireMode,
        resources: desired.resources,
        stage: stageCatalog(desired.config),
      })
      latestDesired = Option.some(desired)
      return {
        profile: publication.value.profile,
        publication,
        desired,
      } satisfies LiveRuntimeProfile
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

  return { refresh, current }
}

/** Construct a graph host for one profile cache key. */
export const makeRuntimeProfileOwnerHost = (params: {
  readonly baseContext: Context.Context<unknown>
}) => makeResourceGraphHost<RuntimeProfileCatalog>(params)
