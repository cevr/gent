/**
 * ExternalDriver primitive — unit tests.
 *
 * Covers: registry compilation, getExternalExecutor resolution,
 * duplicate ID handling.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { DriverRegistry } from "@gent/core/runtime/extensions/driver-registry"
import type { ExtensionContributions, LoadedExtension } from "../../src/domain/extension.js"
import type { TurnError, TurnExecutor, TurnEvent, TurnContext } from "@gent/core/domain/driver"

const noopExecutor: TurnExecutor = {
  executeTurn: () => Stream.empty,
}

const echoExecutor: TurnExecutor = {
  executeTurn: (ctx: TurnContext) =>
    Stream.fromIterable<TurnEvent, TurnError>([
      { _tag: "text-delta", text: `echo: ${ctx.systemPrompt}` },
      { _tag: "finished", stopReason: "stop" },
    ]),
}

const makeExt = (
  id: string,
  externalDrivers?: Array<{ id: string; executor: TurnExecutor }>,
): LoadedExtension => {
  const drivers = externalDrivers?.map((d) => ({ ...d, invalidate: () => Effect.void }))
  return {
    manifest: { id },
    kind: "builtin" as const,
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

  test("getExternalExecutor resolves from driver registry service", async () => {
    const resolved = resolveExtensions([
      makeExt("ext-a", [{ id: "test-executor", executor: echoExecutor }]),
    ])
    const registryLayer = DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* DriverRegistry
        return yield* registry.getExternalExecutor("test-executor")
      }).pipe(Effect.provide(registryLayer)),
    )

    expect(result).toBe(echoExecutor)
  })

  test("getExternalExecutor returns undefined for missing ID", async () => {
    const resolved = resolveExtensions([makeExt("ext-a", [])])
    const registryLayer = DriverRegistry.fromResolved({
      modelDrivers: resolved.modelDrivers,
      externalDrivers: resolved.externalDrivers,
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* DriverRegistry
        return yield* registry.getExternalExecutor("nonexistent")
      }).pipe(Effect.provide(registryLayer)),
    )

    expect(result).toBeUndefined()
  })
})
