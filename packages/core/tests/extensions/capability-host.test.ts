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
  contributions: {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    capabilities: caps as ReadonlyArray<CapabilityContribution<never, never, never>>,
  },
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

  it.live(
    "scope precedence shadows first; audience mismatch on the winner is a hard miss (codex BLOCK on C4.1)",
    () =>
      Effect.gen(function* () {
        // Project narrows audiences to ["human-slash"]; builtin still has ["model"].
        // Invoking from "model" must NOT fall through to the builtin entry — the
        // project override has shadowed `(@x, doThing)` for both audiences.
        const builtinModel: CapabilityContribution<{ value: string }, { value: string }, never> = {
          id: "doThing",
          audiences: ["model"],
          intent: "read",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.Struct({ value: Schema.String }),
          effect: () => Effect.succeed({ value: "leaked-from-builtin" }),
        }
        const projectSlash: CapabilityContribution<{ value: string }, { value: string }, never> = {
          id: "doThing",
          audiences: ["human-slash"],
          intent: "read",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.Struct({ value: Schema.String }),
          effect: () => Effect.succeed({ value: "from-project-slash" }),
        }
        const compiled = compileCapabilities([
          extWith("@test/c", "builtin", [builtinModel]),
          extWith("@test/c", "project", [projectSlash]),
        ])
        // Model invocation must miss: the project entry shadows by identity but
        // its audience set excludes "model".
        const modelMiss = yield* compiled
          .run("@test/c", "doThing", "model", { value: "x" }, ctx)
          .pipe(Effect.flip)
        expect(modelMiss).toBeInstanceOf(CapabilityNotFoundError)
        // Slash invocation hits the project entry.
        const slashHit = yield* compiled.run(
          "@test/c",
          "doThing",
          "human-slash",
          { value: "x" },
          ctx,
        )
        expect(slashHit).toEqual({ value: "from-project-slash" })
      }),
  )

  it.live(
    "listForAudience collapses by identity first — shadowed builtin is invisible to model audience",
    () =>
      Effect.sync(() => {
        const builtinModel: CapabilityContribution<{ value: string }, { value: string }, never> = {
          id: "doThing",
          audiences: ["model"],
          intent: "read",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.Struct({ value: Schema.String }),
          effect: () => Effect.succeed({ value: "leaked" }),
        }
        const projectSlash: CapabilityContribution<{ value: string }, { value: string }, never> = {
          id: "doThing",
          audiences: ["human-slash"],
          intent: "read",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.Struct({ value: Schema.String }),
          effect: () => Effect.succeed({ value: "ok" }),
        }
        const compiled = compileCapabilities([
          extWith("@test/c", "builtin", [builtinModel]),
          extWith("@test/c", "project", [projectSlash]),
        ])
        // The builtin's "model" audience must NOT surface in the listing — it's
        // been shadowed by a higher-precedence registration of the same identity
        // that excludes "model".
        const modelList = compiled.listForAudience("model").map((e) => e.capability.id)
        expect(modelList).toEqual([])
        // The project entry IS visible to its declared audience.
        const slashList = compiled.listForAudience("human-slash").map((e) => e.capability.id)
        expect(slashList).toEqual(["doThing"])
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

  // ── intent gate (codex HIGH on C4.5) ──
  // Replaces the deleted `query-mutation.test.ts` semantic lock: a same-id
  // write capability must be invisible to a `{ intent: "read" }` dispatch
  // (and vice versa) — otherwise `query()` could invoke a write capability
  // and `mutate()` could invoke a read capability if their ids matched.

  it.live("rejects with CapabilityNotFoundError when required intent does not match", () =>
    Effect.gen(function* () {
      // Write capability registered; read-intent dispatch must miss.
      const writeCap: CapabilityContribution<{ value: string }, { value: string }, never> = {
        id: "write-op",
        audiences: ["agent-protocol"],
        intent: "write",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        effect: (input) => Effect.succeed(input),
      }
      const compiled = compileCapabilities([extWith("@test/c", "builtin", [writeCap])])
      const result = yield* compiled
        .run("@test/c", "write-op", "agent-protocol", { value: "x" }, ctx, { intent: "read" })
        .pipe(Effect.flip)
      expect(result).toBeInstanceOf(CapabilityNotFoundError)
    }),
  )

  it.live("matches when intent matches", () =>
    Effect.gen(function* () {
      const readCap: CapabilityContribution<{ value: string }, { value: string }, never> = {
        id: "read-op",
        audiences: ["agent-protocol"],
        intent: "read",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        effect: (input) => Effect.succeed(input),
      }
      const compiled = compileCapabilities([extWith("@test/c", "builtin", [readCap])])
      const result = yield* compiled.run(
        "@test/c",
        "read-op",
        "agent-protocol",
        { value: "x" },
        ctx,
        { intent: "read" },
      )
      expect(result).toEqual({ value: "x" })
    }),
  )

  it.live("undefined intent option matches both intents", () =>
    Effect.gen(function* () {
      const writeCap: CapabilityContribution<{ value: string }, { value: string }, never> = {
        id: "write-op",
        audiences: ["agent-protocol"],
        intent: "write",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        effect: (input) => Effect.succeed(input),
      }
      const compiled = compileCapabilities([extWith("@test/c", "builtin", [writeCap])])
      // No `options.intent` — caller accepts either read or write.
      const result = yield* compiled.run(
        "@test/c",
        "write-op",
        "agent-protocol",
        { value: "x" },
        ctx,
      )
      expect(result).toEqual({ value: "x" })
    }),
  )

  it.live("intent shadow: project read shadows builtin write of same id under read dispatch", () =>
    Effect.gen(function* () {
      // Identity-first scope precedence: a project-scope read capability with
      // the same id MUST shadow the builtin write — and a `{ intent: "write" }`
      // dispatch must NOT fall back to the builtin (codex C4.1 BLOCK pattern
      // applied to intent: scope precedence selects identity, then audience
      // and intent authorize the winner).
      const writeCap: CapabilityContribution<unknown, unknown, never> = {
        id: "thing",
        audiences: ["agent-protocol"],
        intent: "write",
        input: Schema.Unknown,
        output: Schema.Unknown,
        effect: () => Effect.succeed("builtin-write"),
      }
      const readCap: CapabilityContribution<unknown, unknown, never> = {
        id: "thing",
        audiences: ["agent-protocol"],
        intent: "read",
        input: Schema.Unknown,
        output: Schema.Unknown,
        effect: () => Effect.succeed("project-read"),
      }
      const compiled = compileCapabilities([
        extWith("@test/c", "builtin", [writeCap]),
        extWith("@test/c", "project", [readCap]),
      ])
      // Read dispatch finds the project capability.
      const readResult = yield* compiled.run("@test/c", "thing", "agent-protocol", null, ctx, {
        intent: "read",
      })
      expect(readResult).toBe("project-read")
      // Write dispatch must NOT silently fall back to the shadowed builtin.
      const writeResult = yield* compiled
        .run("@test/c", "thing", "agent-protocol", null, ctx, { intent: "write" })
        .pipe(Effect.flip)
      expect(writeResult).toBeInstanceOf(CapabilityNotFoundError)
    }),
  )

  // ── narrow ctx guard (codex MEDIUM on C4.5) ──
  // A handler authored against the wide `ModelCapabilityContext` that reaches
  // for `ctx.extension` (etc.) must surface a clear error when invoked through
  // a non-model dispatch with a narrow `CapabilityCoreContext` — not a
  // "Cannot read properties of undefined" runtime crash.

  it.live("non-model dispatch with narrow ctx throws clear error on wide-ctx access", () =>
    Effect.gen(function* () {
      const widePeekCap: CapabilityContribution<unknown, unknown, never> = {
        id: "wide-peek",
        audiences: ["agent-protocol"],
        intent: "read",
        input: Schema.Unknown,
        output: Schema.Unknown,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        effect: (_, c) => Effect.succeed((c as { extension: { send: unknown } }).extension.send),
      }
      const compiled = compileCapabilities([extWith("@test/c", "builtin", [widePeekCap])])
      // Narrow ctx — no `extension` field.
      const narrowCtx = {
        sessionId: "s",
        branchId: "b",
        cwd: "/tmp",
        home: "/tmp",
      } as const
      const result = yield* compiled
        .run("@test/c", "wide-peek", "agent-protocol", null, narrowCtx, { intent: "read" })
        .pipe(Effect.flip)
      // The defect propagates as a CapabilityError via `catchDefect`.
      expect(result).toBeInstanceOf(CapabilityError)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      expect((result as CapabilityError).reason).toMatch(/wide-context key "extension"/)
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
