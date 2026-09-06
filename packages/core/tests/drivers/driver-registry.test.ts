/**
 * DriverRegistry — unit tests for the unified driver lookup.
 *
 * Covers both categories (model + external) under one registry, scope precedence
 * across categories, and filterModelCatalog composition. Pinned at this seam
 * because every agent turn dispatches through
 * `agent.driver: DriverRef → DriverRegistry`. Regressing scope precedence
 * silently breaks per-cwd extension resolution.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Option, Predicate, Stream } from "effect"
import { LanguageModel, Model as AiModel } from "effect/unstable/ai"
import * as Response from "effect/unstable/ai/Response"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { resolveExtensions } from "../../src/runtime/extensions/registry"
import type { LoadedExtension } from "../../src/domain/extension.js"
import { finishPart } from "@gent/core-internal/test-utils/language-model"
import type {
  ExternalDriverContribution,
  ModelDriverContribution,
  ProviderAuthInfo,
  ProviderResolution,
  TurnExecutor,
} from "@gent/core-internal/domain/driver"
import type { ExtensionContributions } from "@gent/core-internal/domain/contribution"
import { Model, ModelId, ProviderId } from "@gent/core-internal/domain/model"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { failingLanguageModel } from "../helpers/failing-language-model"
const noopInvalidate = Effect.void
const stubResolution = (): Effect.Effect<ProviderResolution> =>
  Effect.succeed(
    AiModel.make("test", "model", Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel)),
  )
const makeModel = (id: string, name?: string): ModelDriverContribution => ({
  id,
  name: Option.getOrElse(Option.fromUndefinedOr(name), () => id),
  resolveModel: stubResolution,
})
const makeCatalogModel = (id: string, keep = true): Model => {
  let contextLength = 0
  if (keep) contextLength = 1
  return Model.make({
    id: ModelId.make(id),
    name: id,
    provider: ProviderId.make(id.split("/", 1)[0] ?? id),
    contextLength,
  })
}
const makeExecutor = (label: string): TurnExecutor => ({
  executeTurn: () =>
    Stream.fromIterable([
      Response.makePart("text-delta", { id: "test-text", delta: label }),
      finishPart({ finishReason: "stop" }),
    ]),
})
const makeExt = (
  id: string,
  scope: "builtin" | "user" | "project",
  opts: {
    readonly modelDrivers?: ReadonlyArray<ModelDriverContribution>
    readonly externalDrivers?: ReadonlyArray<ExternalDriverContribution>
  },
): LoadedExtension => {
  let contributions: ExtensionContributions
  if (!Predicate.isUndefined(opts.modelDrivers) && !Predicate.isUndefined(opts.externalDrivers)) {
    contributions = { modelDrivers: opts.modelDrivers, externalDrivers: opts.externalDrivers }
  } else if (!Predicate.isUndefined(opts.modelDrivers)) {
    contributions = { modelDrivers: opts.modelDrivers }
  } else if (!Predicate.isUndefined(opts.externalDrivers)) {
    contributions = { externalDrivers: opts.externalDrivers }
  } else {
    contributions = {}
  }
  return {
    manifest: { id: ExtensionId.make(id) },
    scope,
    sourcePath: `/test/${id}`,
    contributions,
  }
}
const buildRegistry = (extensions: ReadonlyArray<LoadedExtension>) => {
  const resolved = resolveExtensions(extensions)
  return DriverRegistry.fromResolved({
    modelDrivers: resolved.modelDrivers,
    externalDrivers: resolved.externalDrivers,
  })
}
describe("DriverRegistry", () => {
  it.live("getModel resolves a registered model driver", () =>
    Effect.gen(function* () {
      const layer = buildRegistry([
        makeExt("anthropic-ext", "builtin", { modelDrivers: [makeModel("anthropic")] }),
      ])
      const result = yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.getModel("anthropic")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(result?.id).toBe("anthropic")
    }),
  )
  it.live("getExternal resolves a registered external driver", () =>
    Effect.gen(function* () {
      const exec = makeExecutor("hello")
      const layer = buildRegistry([
        makeExt("acp-ext", "builtin", {
          externalDrivers: [{ id: "acp-claude-code", executor: exec, invalidate: noopInvalidate }],
        }),
      ])
      const result = yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.getExternal("acp-claude-code")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(result?.id).toBe("acp-claude-code")
      expect(result?.executor).toBe(exec)
    }),
  )
  it.live("project scope shadows builtin for same model driver id", () =>
    Effect.gen(function* () {
      const layer = buildRegistry([
        makeExt("ext-builtin", "builtin", { modelDrivers: [makeModel("openai", "Builtin")] }),
        makeExt("ext-project", "project", { modelDrivers: [makeModel("openai", "Project")] }),
      ])
      const result = yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.getModel("openai")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(result?.name).toBe("Project")
    }),
  )
  it.live("project scope shadows builtin for same external driver id", () =>
    Effect.gen(function* () {
      const builtinExec = makeExecutor("builtin")
      const projectExec = makeExecutor("project")
      const layer = buildRegistry([
        makeExt("ext-builtin", "builtin", {
          externalDrivers: [{ id: "shared", executor: builtinExec, invalidate: noopInvalidate }],
        }),
        makeExt("ext-project", "project", {
          externalDrivers: [{ id: "shared", executor: projectExec, invalidate: noopInvalidate }],
        }),
      ])
      const driver = yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.getExternal("shared")
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      expect(driver?.executor).toBe(projectExec)
    }),
  )
  it.live("filterModelCatalog composes every driver's listModels filter", () =>
    Effect.gen(function* () {
      const dropper: ModelDriverContribution = {
        id: "dropper",
        name: "Dropper",
        resolveModel: stubResolution,
        listModels: (catalog) => catalog.filter((model) => model.contextLength !== 0),
      }
      const adder: ModelDriverContribution = {
        id: "adder",
        name: "Adder",
        resolveModel: stubResolution,
        listModels: (catalog) => [...catalog, makeCatalogModel("adder/added")],
      }
      const layer = buildRegistry([makeExt("ext", "builtin", { modelDrivers: [dropper, adder] })])
      const result = yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.filterModelCatalog([
          makeCatalogModel("test/kept"),
          makeCatalogModel("test/dropped", false),
        ])
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      // dropper removes the unkept entry; adder appends one — two remain
      expect(result.length).toBe(2)
      expect(result.some((model) => model.id === "adder/added")).toBe(true)
      expect(result.some((model) => model.id === "test/dropped")).toBe(false)
    }),
  )
  it.live("filterModelCatalog passes resolveAuth(driverId) into each driver's listModels", () =>
    Effect.gen(function* () {
      const seenAuth: Array<{
        driverId: string
        auth: Option.Option<ProviderAuthInfo>
      }> = []
      const driverA: ModelDriverContribution = {
        id: "auth-a",
        name: "AuthA",
        resolveModel: stubResolution,
        listModels: (catalog, auth) => {
          seenAuth.push({ driverId: "auth-a", auth: Option.fromUndefinedOr(auth) })
          return catalog
        },
      }
      const driverB: ModelDriverContribution = {
        id: "auth-b",
        name: "AuthB",
        resolveModel: stubResolution,
        listModels: (catalog, auth) => {
          seenAuth.push({ driverId: "auth-b", auth: Option.fromUndefinedOr(auth) })
          return catalog
        },
      }
      const layer = buildRegistry([
        makeExt("auth-ext", "builtin", { modelDrivers: [driverA, driverB] }),
      ])
      yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.filterModelCatalog([makeCatalogModel("test/x")], (driverId) => {
          if (driverId === "auth-a") return Effect.succeed({ type: "api", key: "secret-a" })
          return Effect.succeed(Option.getOrUndefined(Option.none<ProviderAuthInfo>()))
        })
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(layer))
      // Each driver's listModels should have been called with the auth from resolveAuth(its id)
      const authAEntry = Option.fromUndefinedOr(seenAuth.find((s) => s.driverId === "auth-a"))
      expect(Option.isSome(authAEntry)).toBe(true)
      if (Option.isNone(authAEntry)) return
      expect(Option.isSome(authAEntry.value.auth)).toBe(true)
      if (Option.isNone(authAEntry.value.auth)) return
      expect(authAEntry.value.auth.value.key).toBe("secret-a")
      const authBEntry = Option.fromUndefinedOr(seenAuth.find((s) => s.driverId === "auth-b"))
      expect(Option.isSome(authBEntry)).toBe(true)
      if (Option.isNone(authBEntry)) return
      expect(Option.isNone(authBEntry.value.auth)).toBe(true)
    }),
  )
  it.live("filterModelCatalog rejects malformed runtime filter output", () =>
    Effect.gen(function* () {
      const malformed = makeCatalogModel("broken/invalid")
      Reflect.set(malformed, "name", 42)
      const broken: ModelDriverContribution = {
        id: "broken",
        name: "Broken",
        resolveModel: stubResolution,
        listModels: () => [malformed],
      }
      const layer = buildRegistry([makeExt("broken-ext", "builtin", { modelDrivers: [broken] })])
      const result = yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.filterModelCatalog([makeCatalogModel("test/x")])
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(layer),
        Effect.catchEager((error) =>
          Effect.sync(() => {
            let message = error.message
            if (error._tag === "DriverError") message = error.reason
            return message
          }),
        ),
      )
      expect(result).toContain("invalid model catalog")
    }),
  )
})
