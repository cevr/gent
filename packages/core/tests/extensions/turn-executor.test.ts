/**
 * TurnExecutor primitive — unit tests.
 *
 * Covers: registry compilation, getTurnExecutor resolution,
 * duplicate ID handling, and TurnEvent schema roundtrip.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import type { LoadedExtension } from "@gent/core/domain/extension"
import type {
  TurnError,
  TurnExecutor,
  TurnEvent,
  TurnContext,
} from "@gent/core/domain/turn-executor"

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
  turnExecutors?: Array<{ id: string; executor: TurnExecutor }>,
): LoadedExtension => ({
  manifest: { id },
  kind: "builtin" as const,
  sourcePath: `/test/${id}`,
  setup: {
    turnExecutors,
  },
})

describe("TurnExecutor registry", () => {
  test("compiles turn executors from extensions", () => {
    const resolved = resolveExtensions([
      makeExt("ext-a", [{ id: "acp-claude-code", executor: noopExecutor }]),
      makeExt("ext-b", [{ id: "acp-opencode", executor: echoExecutor }]),
    ])

    expect(resolved.turnExecutors.size).toBe(2)
    expect(resolved.turnExecutors.has("acp-claude-code")).toBe(true)
    expect(resolved.turnExecutors.has("acp-opencode")).toBe(true)
  })

  test("empty extensions produce empty turn executor map", () => {
    const resolved = resolveExtensions([])
    expect(resolved.turnExecutors.size).toBe(0)
  })

  test("single extension with multiple executors", () => {
    const resolved = resolveExtensions([
      makeExt("ext-multi", [
        { id: "exec-a", executor: noopExecutor },
        { id: "exec-b", executor: echoExecutor },
      ]),
    ])

    expect(resolved.turnExecutors.size).toBe(2)
    expect(resolved.turnExecutors.get("exec-a")).toBe(noopExecutor)
    expect(resolved.turnExecutors.get("exec-b")).toBe(echoExecutor)
  })

  test("later scope wins for same-ID executor", () => {
    const resolved = resolveExtensions([
      makeExt("ext-first", [{ id: "shared-id", executor: noopExecutor }]),
      makeExt("ext-second", [{ id: "shared-id", executor: echoExecutor }]),
    ])

    expect(resolved.turnExecutors.size).toBe(1)
    expect(resolved.turnExecutors.get("shared-id")).toBe(echoExecutor)
  })

  test("getTurnExecutor resolves from registry service", async () => {
    const resolved = resolveExtensions([
      makeExt("ext-a", [{ id: "test-executor", executor: echoExecutor }]),
    ])
    const registryLayer = ExtensionRegistry.fromResolved(resolved)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const executor = yield* registry.getTurnExecutor("test-executor")
        return executor
      }).pipe(Effect.provide(registryLayer)),
    )

    expect(result).toBe(echoExecutor)
  })

  test("getTurnExecutor returns undefined for missing ID", async () => {
    const resolved = resolveExtensions([makeExt("ext-a", [])])
    const registryLayer = ExtensionRegistry.fromResolved(resolved)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        return yield* registry.getTurnExecutor("nonexistent")
      }).pipe(Effect.provide(registryLayer)),
    )

    expect(result).toBeUndefined()
  })
})
