/**
 * ExternalDriver primitive — unit tests.
 *
 * Covers: registry compilation, getExternal resolution, duplicate ID
 * handling.
 */
import { describe, test, expect, it } from "effect-bun-test"
import { Effect, Stream } from "effect"
import * as Response from "effect/unstable/ai/Response"
import { resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import type { ExtensionContributions, LoadedExtension } from "../../src/domain/extension.js"
import { ExtensionId } from "@gent/core-internal/domain/ids"
import { finishPart } from "@gent/core-internal/test-utils/language-model"
import type { TurnExecutor } from "@gent/core-internal/domain/driver"
const noopExecutor: TurnExecutor = {
  executeTurn: () => Stream.empty,
}
const echoExecutor: TurnExecutor = {
  executeTurn: (ctx) =>
    Stream.fromIterable([
      Response.makePart("text-delta", { id: "test-text", delta: `echo: ${ctx.systemPrompt}` }),
      finishPart({ finishReason: "stop" }),
    ]),
}
const makeExt = (
  id: string,
  externalDrivers?: Array<{
    id: string
    executor: TurnExecutor
  }>,
): LoadedExtension => {
  const drivers = externalDrivers?.map((d) => ({ ...d, invalidate: () => Effect.void }))
  return {
    manifest: { id: ExtensionId.make(id) },
    scope: "builtin" as const,
    sourcePath: `/test/${id}`,
    contributions: (drivers !== undefined && drivers.length > 0
      ? { externalDrivers: drivers }
      : {}) as ExtensionContributions,
  }
}
describe("ExternalDriver registry", () => {
  test("compiles external drivers from extensions", () => {
    const resolved = resolveExtensions([
      makeExt("ext-a", [{ id: "acp-claude-code", executor: noopExecutor }]),
      makeExt("ext-b", [{ id: "acp-opencode", executor: echoExecutor }]),
    ])
    expect(resolved.externalDrivers.size).toBe(2)
    expect(resolved.externalDrivers.has("acp-claude-code")).toBe(true)
    expect(resolved.externalDrivers.has("acp-opencode")).toBe(true)
  })
  test("empty extensions produce empty external driver map", () => {
    const resolved = resolveExtensions([])
    expect(resolved.externalDrivers.size).toBe(0)
  })
  test("single extension with multiple drivers", () => {
    const resolved = resolveExtensions([
      makeExt("ext-multi", [
        { id: "exec-a", executor: noopExecutor },
        { id: "exec-b", executor: echoExecutor },
      ]),
    ])
    expect(resolved.externalDrivers.size).toBe(2)
    expect(resolved.externalDrivers.get("exec-a")?.executor).toBe(noopExecutor)
    expect(resolved.externalDrivers.get("exec-b")?.executor).toBe(echoExecutor)
  })
  test("later scope wins for same-ID driver", () => {
    const resolved = resolveExtensions([
      makeExt("ext-first", [{ id: "shared-id", executor: noopExecutor }]),
      makeExt("ext-second", [{ id: "shared-id", executor: echoExecutor }]),
    ])
    expect(resolved.externalDrivers.size).toBe(1)
    expect(resolved.externalDrivers.get("shared-id")?.executor).toBe(echoExecutor)
  })
  it.live("getExternal resolves driver with executor from registry service", () =>
    Effect.gen(function* () {
      const resolved = resolveExtensions([
        makeExt("ext-a", [{ id: "test-executor", executor: echoExecutor }]),
      ])
      const registryLayer = DriverRegistry.fromResolved({
        modelDrivers: resolved.modelDrivers,
        externalDrivers: resolved.externalDrivers,
      })
      const driver = yield* Effect.gen(function* () {
        const registry = yield* DriverRegistry
        return yield* registry.getExternal("test-executor")
      }).pipe(Effect.provide(registryLayer))
      expect(driver?.executor).toBe(echoExecutor)
    }),
  )
  it.live("getExternal returns undefined for missing ID", () =>
    Effect.gen(function* () {
      const resolved = resolveExtensions([makeExt("ext-a", [])])
      const registryLayer = DriverRegistry.fromResolved({
        modelDrivers: resolved.modelDrivers,
        externalDrivers: resolved.externalDrivers,
      })
      const result = yield* Effect.gen(function* () {
        const registry = yield* DriverRegistry
        return yield* registry.getExternal("nonexistent")
      }).pipe(Effect.provide(registryLayer))
      expect(result).toBeUndefined()
    }),
  )
})
