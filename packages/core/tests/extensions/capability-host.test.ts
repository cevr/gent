/**
 * CapabilityHost regression locks (C4.1 skeleton).
 *
 * Locks the new typed-callable contract:
 *  - `compileCapabilities` registers entries from sorted extensions
 *  - dispatch by `(extensionId, capabilityId, audience)` finds the
 *    highest-precedence registration (project > user > builtin)
 *  - audience filtering: a Capability registered for `["model"]` is invisible
 *    to a `"human-slash"` invocation (returns `CapabilityNotFoundError`)
 *  - input is decoded via Schema before reaching the handler — bad input fails
 *    as `CapabilityError` with reason "input decode failed"
 *  - output is validated via Schema (encode-as-validation) — bad output fails
 *    as `CapabilityError` with reason "output validation failed"
 *  - missing `(extensionId, capabilityId)` returns `CapabilityNotFoundError`
 *  - handler defects are coerced into typed errors (no defects escape)
 *  - `listForAudience` filters Capabilities by audience membership
 *
 * Tied to planify Commit C4.1. If audience-based dispatch stops respecting
 * scope precedence or audience membership, the new substrate has regressed.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Schema } from "effect"
import type { LoadedExtension } from "@gent/core/domain/extension"
import {
  type CapabilityContribution,
  type CapabilityContext,
  CapabilityError,
  CapabilityNotFoundError,
  type Audience,
} from "@gent/core/domain/capability"
import { compileCapabilities } from "@gent/core/runtime/extensions/capability-host"
import { capability as capabilityContribution } from "@gent/core/domain/contribution"

// CapabilityContext extends ExtensionHostContext (large RPC surface). Tests
// for the skeleton don't exercise extension RPC; cast a minimal shape.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const ctx = {
  sessionId: "s",
  branchId: "b",
  cwd: "/tmp",
  home: "/tmp",
} as unknown as CapabilityContext

const extWith = (
  id: string,
  kind: "builtin" | "user" | "project",
  caps: ReadonlyArray<CapabilityContribution<unknown, unknown, never>>,
): LoadedExtension => ({
  manifest: { id },
  kind,
  sourcePath: `/test/${id}`,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  contributions: (caps as ReadonlyArray<CapabilityContribution<never, never, never>>).map(
    capabilityContribution,
  ),
})

const echoCap = (
  id: string,
  audiences: ReadonlyArray<Audience>,
): CapabilityContribution<{ value: string }, { value: string }, never> => ({
  id,
  audiences,
  intent: "read",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ value: Schema.String }),
  effect: (input) => Effect.succeed({ value: input.value }),
})

describe("capability-host", () => {
  it.live("dispatches by (extensionId, capabilityId, audience) and returns decoded output", () =>
    Effect.gen(function* () {
      const compiled = compileCapabilities([
        extWith("@test/c", "builtin", [echoCap("echo", ["model"])]),
      ])
      const result = yield* compiled.run("@test/c", "echo", "model", { value: "hi" }, ctx)
      expect(result).toEqual({ value: "hi" })
    }),
  )

  it.live("returns CapabilityNotFoundError when (extensionId, capabilityId) is unknown", () =>
    Effect.gen(function* () {
      const compiled = compileCapabilities([])
      const result = yield* compiled.run("@x", "missing", "model", {}, ctx).pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityNotFoundError)
    }),
  )

  it.live("rejects with CapabilityNotFoundError when audience does not match", () =>
    Effect.gen(function* () {
      // Capability registered for "model" only; invoking from "human-slash" must miss.
      const compiled = compileCapabilities([
        extWith("@test/c", "builtin", [echoCap("echo", ["model"])]),
      ])
      const result = yield* compiled
        .run("@test/c", "echo", "human-slash", { value: "hi" }, ctx)
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityNotFoundError)
    }),
  )

  it.live("project scope wins over builtin for the same (extensionId, capabilityId)", () =>
    Effect.gen(function* () {
      const builtinCap: CapabilityContribution<{ value: string }, { value: string }, never> = {
        id: "echo",
        audiences: ["model"],
        intent: "read",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        effect: () => Effect.succeed({ value: "from-builtin" }),
      }
      const projectCap: CapabilityContribution<{ value: string }, { value: string }, never> = {
        id: "echo",
        audiences: ["model"],
        intent: "read",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        effect: () => Effect.succeed({ value: "from-project" }),
      }
      const compiled = compileCapabilities([
        extWith("@test/c", "builtin", [builtinCap]),
        extWith("@test/c", "project", [projectCap]),
      ])
      const result = yield* compiled.run("@test/c", "echo", "model", { value: "x" }, ctx)
      expect(result).toEqual({ value: "from-project" })
    }),
  )

  it.live("input decode failure is wrapped in CapabilityError", () =>
    Effect.gen(function* () {
      const compiled = compileCapabilities([
        extWith("@test/c", "builtin", [echoCap("echo", ["model"])]),
      ])
      const result = yield* compiled
        .run("@test/c", "echo", "model", { value: 42 }, ctx)
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityError)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      expect((result as CapabilityError).reason).toMatch(/input decode failed/)
    }),
  )

  it.live("output validation failure is wrapped in CapabilityError", () =>
    Effect.gen(function* () {
      const badOutputCap: CapabilityContribution<{ value: string }, { value: string }, never> = {
        id: "bad",
        audiences: ["model"],
        intent: "read",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        effect: () => Effect.succeed({ value: 42 } as unknown as { value: string }),
      }
      const compiled = compileCapabilities([extWith("@test/c", "builtin", [badOutputCap])])
      const result = yield* compiled
        .run("@test/c", "bad", "model", { value: "x" }, ctx)
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityError)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      expect((result as CapabilityError).reason).toMatch(/output validation failed/)
    }),
  )

  it.live("handler defects are coerced into typed CapabilityError", () =>
    Effect.gen(function* () {
      const defectCap: CapabilityContribution<{ value: string }, { value: string }, never> = {
        id: "boom",
        audiences: ["model"],
        intent: "read",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        effect: () => Effect.die("boom"),
      }
      const compiled = compileCapabilities([extWith("@test/c", "builtin", [defectCap])])
      const result = yield* compiled
        .run("@test/c", "boom", "model", { value: "x" }, ctx)
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityError)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      expect((result as CapabilityError).reason).toMatch(/handler defect/)
    }),
  )

  it.live("listForAudience returns only Capabilities including that audience", () =>
    Effect.sync(() => {
      const compiled = compileCapabilities([
        extWith("@test/c", "builtin", [
          echoCap("model-only", ["model"]),
          echoCap("dual", ["model", "human-slash"]),
          echoCap("slash-only", ["human-slash"]),
        ]),
      ])
      const modelIds = compiled.listForAudience("model").map((e) => e.capability.id)
      expect(modelIds).toEqual(["model-only", "dual"])
      const slashIds = compiled.listForAudience("human-slash").map((e) => e.capability.id)
      expect(slashIds).toEqual(["dual", "slash-only"])
      const palette = compiled.listForAudience("human-palette")
      expect(palette).toEqual([])
    }),
  )
})
