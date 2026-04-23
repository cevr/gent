/**
 * DriverRegistry — unit tests for the unified driver lookup.
 *
 * Covers both kinds (model + external) under one registry, scope precedence
 * across kinds, requireModel/requireExternal failure, and filterModelCatalog
 * composition. Pinned at this seam because every agent turn dispatches through
 * `agent.driver: DriverRef → DriverRegistry`. Regressing scope precedence or
 * the require* fallthrough silently breaks per-cwd extension resolution.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { DriverRegistry } from "@gent/core/runtime/extensions/driver-registry"
import { resolveExtensions } from "@gent/core/runtime/extensions/registry"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type {
  ExternalDriverContribution,
  ModelDriverContribution,
  ProviderAuthInfo,
  ProviderResolution,
  TurnError,
  TurnEvent,
  TurnExecutor,
} from "@gent/core/domain/driver"
import type { ExtensionContributions } from "@gent/core/domain/contribution"
import { Model, ModelId } from "@gent/core/domain/model"

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
    provider: id.split("/", 1)[0] ?? id,
    contextLength: keep ? 1 : 0,
  })

const makeExecutor = (label: string): TurnExecutor => ({
  executeTurn: () =>
    Stream.fromIterable<TurnEvent, TurnError>([
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
    manifest: { id },
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
  test("getModel resolves a registered model driver", async () => {
    const layer = buildRegistry([
      makeExt("anthropic-ext", "builtin", { modelDrivers: [makeModel("anthropic")] }),
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.getModel("anthropic")
      }).pipe(Effect.provide(layer)),
    )
    expect(result?.id).toBe("anthropic")
  })

  test("getExternal resolves a registered external driver", async () => {
    const exec = makeExecutor("hello")
    const layer = buildRegistry([
      makeExt("acp-ext", "builtin", {
        externalDrivers: [{ id: "acp-claude-code", executor: exec, invalidate: noopInvalidate }],
      }),
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.getExternal("acp-claude-code")
      }).pipe(Effect.provide(layer)),
    )
    expect(result?.id).toBe("acp-claude-code")
    expect(result?.executor).toBe(exec)
  })

  test("project scope shadows builtin for same model driver id", async () => {
    const layer = buildRegistry([
      makeExt("ext-builtin", "builtin", { modelDrivers: [makeModel("openai", "Builtin")] }),
      makeExt("ext-project", "project", { modelDrivers: [makeModel("openai", "Project")] }),
    ])
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.getModel("openai")
      }).pipe(Effect.provide(layer)),
    )
    expect(result?.name).toBe("Project")
  })

  test("project scope shadows builtin for same external driver id", async () => {
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
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.getExternalExecutor("shared")
      }).pipe(Effect.provide(layer)),
    )
    expect(result).toBe(projectExec)
  })

  test("requireModel fails with DriverError when missing", async () => {
    const layer = buildRegistry([])
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.requireModel("nonexistent")
      }).pipe(Effect.provide(layer)),
    )
    expect(result._tag).toBe("Failure")
  })

  test("requireExternal fails with DriverError when missing", async () => {
    const layer = buildRegistry([])
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.requireExternal("missing")
      }).pipe(Effect.provide(layer)),
    )
    expect(result._tag).toBe("Failure")
  })

  test("filterModelCatalog composes every driver's listModels filter", async () => {
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

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.filterModelCatalog([
          makeCatalogModel("test/kept"),
          makeCatalogModel("test/dropped", false),
        ])
      }).pipe(Effect.provide(layer)),
    )

    // dropper removes the unkept entry; adder appends one — two remain
    expect(result.length).toBe(2)
    expect(result.some((model) => model.id === "adder/added")).toBe(true)
    expect(result.some((model) => model.id === "test/dropped")).toBe(false)
  })

  test("filterModelCatalog passes resolveAuth(driverId) into each driver's listModels", async () => {
    const seenAuth: Array<{ driverId: string; auth: ProviderAuthInfo | undefined }> = []
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

    await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.filterModelCatalog([makeCatalogModel("test/x")], (driverId) =>
          Effect.succeed(
            driverId === "auth-a" ? { type: "api" as const, key: "secret-a" } : undefined,
          ),
        )
      }).pipe(Effect.provide(layer)),
    )

    // Each driver's listModels should have been called with the auth from resolveAuth(its id)
    const authA = seenAuth.find((s) => s.driverId === "auth-a")?.auth
    const authB = seenAuth.find((s) => s.driverId === "auth-b")?.auth
    expect(authA?.key).toBe("secret-a")
    expect(authB).toBeUndefined()
  })

  test("filterModelCatalog rejects malformed runtime filter output", async () => {
    const malformed = makeCatalogModel("broken/invalid")
    Reflect.set(malformed, "name", 42)
    const broken: ModelDriverContribution = {
      id: "broken",
      name: "Broken",
      resolveModel: stubResolution,
      listModels: () => [malformed],
    }
    const layer = buildRegistry([makeExt("broken-ext", "builtin", { modelDrivers: [broken] })])

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const reg = yield* DriverRegistry
        return yield* reg.filterModelCatalog([makeCatalogModel("test/x")])
      }).pipe(
        Effect.provide(layer),
        Effect.catchEager((error) => Effect.succeed(error.reason)),
      ),
    )

    expect(result).toContain("invalid model catalog")
  })
})
