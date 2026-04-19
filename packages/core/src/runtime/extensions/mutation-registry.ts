/**
 * MutationRegistry — typed dispatch over `MutationContribution[]`.
 *
 * Routes `(extensionId, mutationId, input)` to the registered contribution,
 * validates input/output via Schema, runs the handler Effect with the
 * extension's contributed Layer providing `R`. Replaces the
 * `actor.mapRequest → Machine event → slot fn` indirection used by the
 * legacy task actor for write operations.
 *
 * Scope precedence: project > user > builtin (highest-precedence registration
 * for a given `(extensionId, mutationId)` wins). Same rule as projections /
 * queries.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import type { LoadedExtension } from "../../domain/extension.js"
import { type AnyCapabilityContribution } from "../../domain/capability.js"
import { extractCapabilities, extractMutations } from "../../domain/contribution.js"
import {
  MutationError,
  MutationNotFoundError,
  type AnyMutationContribution,
  type MutationContext,
} from "../../domain/mutation.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

interface RegisteredMutation {
  readonly extensionId: string
  readonly mutation: AnyMutationContribution
}

export interface CompiledMutations {
  readonly entries: ReadonlyArray<RegisteredMutation>
  readonly run: (
    extensionId: string,
    mutationId: string,
    input: unknown,
    ctx: MutationContext,
  ) => Effect.Effect<unknown, MutationError | MutationNotFoundError>
}

const sortedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

/**
 * C4.2 bridge — lower a `Capability` whose `intent: "write"` includes the
 * `"agent-protocol"` audience into a `MutationContribution`-shaped adapter
 * so the legacy `compileMutations` dispatch path keeps working while
 * extensions migrate. Mirrors the bridge in `query-registry.ts`. Deleted in
 * C4.5 along with the legacy MutationContribution type.
 */
const capabilityToMutation = (cap: AnyCapabilityContribution): AnyMutationContribution => ({
  id: cap.id,
  input: cap.input,
  output: cap.output,
  handler: (input, ctx) => {
    // See `query-registry.capabilityToQuery` for the rationale on this cast —
    // the bridged ctx satisfies CapabilityCoreContext at every real call site.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const wideCtx = ctx as unknown as Parameters<typeof cap.effect>[1]
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at registry boundary
    return cap.effect(input, wideCtx).pipe(
      Effect.catchTag("@gent/core/src/domain/capability/CapabilityError", (e) =>
        Effect.fail(
          new MutationError({
            extensionId: e.extensionId,
            mutationId: e.capabilityId,
            reason: e.reason,
          }),
        ),
      ),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    ) as ReturnType<AnyMutationContribution["handler"]>
  },
})

/** Compile registered mutations into a dispatcher. */
export const compileMutations = (extensions: ReadonlyArray<LoadedExtension>): CompiledMutations => {
  const sorted = sortedExtensions(extensions)
  const entries: RegisteredMutation[] = []
  for (const ext of sorted) {
    for (const mutation of extractMutations(ext.contributions)) {
      entries.push({ extensionId: ext.manifest.id, mutation })
    }
    // Bridge: write+agent-protocol capabilities show up here as mutations.
    for (const capability of extractCapabilities(ext.contributions)) {
      if (capability.intent !== "write") continue
      if (!capability.audiences.includes("agent-protocol")) continue
      entries.push({ extensionId: ext.manifest.id, mutation: capabilityToMutation(capability) })
    }
  }

  const findEntry = (extensionId: string, mutationId: string): RegisteredMutation | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i]
      if (
        candidate !== undefined &&
        candidate.extensionId === extensionId &&
        candidate.mutation.id === mutationId
      ) {
        return candidate
      }
    }
    return undefined
  }

  const run: CompiledMutations["run"] = (extensionId, mutationId, input, ctx) =>
    Effect.gen(function* () {
      const entry = findEntry(extensionId, mutationId)
      if (entry === undefined) {
        return yield* new MutationNotFoundError({ extensionId, mutationId })
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const decodedInput = yield* Schema.decodeUnknownEffect(entry.mutation.input as Schema.Any)(
        input,
      ).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new MutationError({
              extensionId,
              mutationId,
              reason: `input decode failed: ${String(e)}`,
            }),
          ),
        ),
      )
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — mutation R/E erased at registry boundary
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const handlerEffect = entry.mutation.handler(decodedInput, ctx) as Effect.Effect<
        unknown,
        MutationError
      >
      const output = yield* handlerEffect.pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            new MutationError({
              extensionId,
              mutationId,
              reason: `handler defect: ${String(defect)}`,
            }),
          ),
        ),
      )
      // Validate output shape — handler returns typed (decoded) form; encode
      // confirms it matches the schema contract. Return the original typed value.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      yield* Schema.encodeUnknownEffect(entry.mutation.output as Schema.Any)(output).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new MutationError({
              extensionId,
              mutationId,
              reason: `output validation failed: ${String(e)}`,
            }),
          ),
        ),
      )
      return output
    })

  return { entries, run }
}
