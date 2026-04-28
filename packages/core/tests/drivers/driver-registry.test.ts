/**
 * DriverRegistry — unit tests for the unified driver lookup.
 *
 * Covers both categories (model + external) under one registry, scope precedence
 * across categories, requireModel/requireExternal failure, and filterModelCatalog
 * composition. Pinned at this seam because every agent turn dispatches through
 * `agent.driver: DriverRef → DriverRegistry`. Regressing scope precedence or
 * the require* fallthrough silently breaks per-cwd extension resolution.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Stream } from "effect"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { resolveExtensions } from "../../src/runtime/extensions/registry"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type {
  ExternalDriverContribution,
  ModelDriverContribution,
  ProviderAuthInfo,
  ProviderResolution,
  TurnEvent,
  TurnExecutor,
} from "@gent/core/domain/driver"
import type { ExtensionContributions } from "@gent/core/domain/contribution"
import { Model, ModelId, ProviderId } from "@gent/core/domain/model"
import { ExtensionId } from "@gent/core/domain/ids"
const noopInvalidate = (): Effect.Effect<void> => Effect.void
const stubResolution = (): ProviderResolution => ({ layer: Layer.empty as never })
const makeModel = (id: string, name?: string): ModelDriverContribution => ({
  id,
  name: name ?? id,
  resolveModel: stubResolution,
})
const makeCatalogModel = (id: string, keep = true): Model =>
  Model.make({
    id: ModelId.make(id),
    name: id,
    provider: ProviderId.make(id.split("/", 1)[0] ?? id),
    contextLength: keep ? 1 : 0,
  })
const makeExecutor = (label: string): TurnExecutor => ({
  executeTurn: () =>
    Stream.fromIterable<TurnEvent>([
      { _tag: "text-delta", text: label },
      { _tag: "finished", stopReason: "stop" },
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
  const contributions: ExtensionContributions = {
    ...(opts.modelDrivers !== undefined && { modelDrivers: opts.modelDrivers }),
    ...(opts.externalDrivers !== undefined && { externalDrivers: opts.externalDrivers }),
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
      const result = yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.getExternalExecutor("shared")
      }).pipe(Effect.provide(layer))
      expect(result).toBe(projectExec)
    }),
  )
  it.live("requireModel fails with DriverError when missing", () =>
    Effect.gen(function* () {
      const layer = buildRegistry([])
      const result = yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.requireModel("nonexistent")
      }).pipe(Effect.provide(layer), Effect.flip)
      expect(result.driver._tag).toBe("model")
      expect(result.driver.id).toBe("nonexistent")
    }),
  )
  it.live("requireExternal fails with DriverError when missing", () =>
    Effect.gen(function* () {
      const layer = buildRegistry([])
      const result = yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.requireExternal("missing")
      }).pipe(Effect.provide(layer), Effect.flip)
      expect(result.driver._tag).toBe("external")
      expect(result.driver.id).toBe("missing")
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
        auth: ProviderAuthInfo | undefined
      }> = []
      const driverA: ModelDriverContribution = {
        id: "auth-a",
        name: "AuthA",
        resolveModel: stubResolution,
        listModels: (catalog, auth) => {
          seenAuth.push({ driverId: "auth-a", auth })
          return catalog
        },
      }
      const driverB: ModelDriverContribution = {
        id: "auth-b",
        name: "AuthB",
        resolveModel: stubResolution,
        listModels: (catalog, auth) => {
          seenAuth.push({ driverId: "auth-b", auth })
          return catalog
        },
      }
      const layer = buildRegistry([
        makeExt("auth-ext", "builtin", { modelDrivers: [driverA, driverB] }),
      ])
      yield* Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.filterModelCatalog([makeCatalogModel("test/x")], (driverId) =>
          Effect.succeed(
            driverId === "auth-a" ? { type: "api" as const, key: "secret-a" } : undefined,
          ),
        )
      }).pipe(Effect.provide(layer))
      // Each driver's listModels should have been called with the auth from resolveAuth(its id)
      const authA = seenAuth.find((s) => s.driverId === "auth-a")?.auth
      const authB = seenAuth.find((s) => s.driverId === "auth-b")?.auth
      expect(authA?.key).toBe("secret-a")
      expect(authB).toBeUndefined()
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
        Effect.provide(layer),
        Effect.catchEager((error) =>
          Effect.succeed(error._tag === "DriverError" ? error.reason : error.message),
        ),
      )
      expect(result).toContain("invalid model catalog")
    }),
  )
})
