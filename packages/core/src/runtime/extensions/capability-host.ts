/**
 * CapabilityHost — typed dispatch over `CapabilityContribution[]`.
 *
 * One host for what the legacy substrate split across `tool-registry`,
 * `query-registry`, `mutation-registry`, and `command-registry`. Routes
 * `(extensionId, capabilityId, audience, input)` to the registered
 * Capability, validates input/output via Schema, runs the effect with the
 * extension's contributed Layer providing `R`.
 *
 * Sequencing per `migrate-callers-then-delete-legacy-apis`:
 *   - C4.1 (here): host skeleton + compileCapabilities; no migration yet.
 *     Legacy hosts continue to serve their kinds.
 *   - C4.2/3/4: migrate query / mutation / command / tool, one kind per
 *     commit, smart constructors emit Capability under the hood.
 *   - C4.5: delete the legacy hosts + per-kind types.
 *
 * Scope precedence: project > user > builtin (highest-precedence
 * registration for a given `(extensionId, capabilityId)` wins). Same rule
 * as queries/mutations.
 *
 * Audience filtering: callers pass the audience they're invoking from
 * (e.g., the tool-runner passes `"model"`, the slash-command dispatcher
 * passes `"human-slash"`). The host rejects with `CapabilityNotFoundError`
 * when the registered Capability does not include the requested audience —
 * preventing the LLM from invoking transport-public-only RPCs and
 * vice-versa.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import type { LoadedExtension } from "../../domain/extension.js"
import { extractCapabilities } from "../../domain/contribution.js"
import {
  CapabilityError,
  CapabilityNotFoundError,
  type AnyCapabilityContribution,
  type Audience,
  type CapabilityContext,
} from "../../domain/capability.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

interface RegisteredCapability {
  readonly extensionId: string
  readonly capability: AnyCapabilityContribution
}

export interface CompiledCapabilities {
  readonly entries: ReadonlyArray<RegisteredCapability>
  /** Run a Capability by `(extensionId, capabilityId)` from a given audience.
   *
   *  Validates input + output via Schema. Rejects with
   *  `CapabilityNotFoundError` when the Capability is not registered OR
   *  when the registered Capability does not include the requested
   *  audience. */
  readonly run: (
    extensionId: string,
    capabilityId: string,
    audience: Audience,
    input: unknown,
    ctx: CapabilityContext,
  ) => Effect.Effect<unknown, CapabilityError | CapabilityNotFoundError>
  /** List Capabilities filtered to those that include `audience`. Used by
   *  surface-specific renderers (e.g., the tool-runner enumerates
   *  `audience: "model"` Capabilities to build the LLM tool list). */
  readonly listForAudience: (audience: Audience) => ReadonlyArray<RegisteredCapability>
}

const sortedExtensions = (
  extensions: ReadonlyArray<LoadedExtension>,
): ReadonlyArray<LoadedExtension> =>
  [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_PRECEDENCE[a.kind] - SCOPE_PRECEDENCE[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

/** Compile registered Capabilities into a dispatcher. */
export const compileCapabilities = (
  extensions: ReadonlyArray<LoadedExtension>,
): CompiledCapabilities => {
  const sorted = sortedExtensions(extensions)
  const entries: RegisteredCapability[] = []
  for (const ext of sorted) {
    for (const capability of extractCapabilities(ext.contributions)) {
      entries.push({ extensionId: ext.manifest.id, capability })
    }
  }

  /**
   * Resolve `(extensionId, capabilityId)` by **scope precedence first**, then
   * authorize on audience. A higher-scope registration shadows lower-scope
   * registrations of the same identity even when the higher entry does not
   * include the requested audience — otherwise a project override could
   * narrow audiences but the lower-scope contribution would still leak
   * through (codex BLOCK on C4.1: "scope precedence should apply to the
   * capability identity first, then audience should authorize that selected
   * contribution").
   */
  const resolveByIdentity = (
    extensionId: string,
    capabilityId: string,
  ): RegisteredCapability | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i]
      if (
        candidate !== undefined &&
        candidate.extensionId === extensionId &&
        candidate.capability.id === capabilityId
      ) {
        return candidate
      }
    }
    return undefined
  }

  /** Identity-resolve, then check audience authorization on the winner. */
  const findEntry = (
    extensionId: string,
    capabilityId: string,
    audience: Audience,
  ): RegisteredCapability | undefined => {
    const winner = resolveByIdentity(extensionId, capabilityId)
    if (winner === undefined) return undefined
    return winner.capability.audiences.includes(audience) ? winner : undefined
  }

  /**
   * Listing also collapses by identity first (last-scope-wins) so a project
   * override that narrows audiences correctly hides the shadowed builtin.
   * Walks forward and overwrites prior entries for the same identity so the
   * highest-precedence registration wins while preserving the registration
   * order of distinct identities (the shape callers expect for tool-list
   * rendering).
   */
  const listForAudience = (audience: Audience): ReadonlyArray<RegisteredCapability> => {
    const winners = new Map<string, RegisteredCapability>()
    for (const e of entries) {
      const key = `${e.extensionId}\u0000${e.capability.id}`
      winners.set(key, e)
    }
    return Array.from(winners.values()).filter((e) => e.capability.audiences.includes(audience))
  }

  const run: CompiledCapabilities["run"] = (extensionId, capabilityId, audience, input, ctx) =>
    Effect.gen(function* () {
      const entry = findEntry(extensionId, capabilityId, audience)
      if (entry === undefined) {
        return yield* new CapabilityNotFoundError({ extensionId, capabilityId })
      }
      // Decode input — caller-supplied, validated at the boundary.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const decodedInput = yield* Schema.decodeUnknownEffect(entry.capability.input as Schema.Any)(
        input,
      ).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId,
              capabilityId,
              reason: `input decode failed: ${String(e)}`,
            }),
          ),
        ),
      )
      // Run effect — R is provided by the extension's contributed Layer at
      // composition time; the host treats it as already-provided.
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at registry boundary
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const handlerEffect = entry.capability.effect(decodedInput, ctx) as Effect.Effect<
        unknown,
        CapabilityError
      >
      const output = yield* handlerEffect.pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            new CapabilityError({
              extensionId,
              capabilityId,
              reason: `handler defect: ${String(defect)}`,
            }),
          ),
        ),
      )
      // Validate output shape — handler returns typed (decoded) form; encode
      // confirms it matches the schema contract. Misshape is a host bug.
      // Return the original typed value (callers expect decoded form).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      yield* Schema.encodeUnknownEffect(entry.capability.output as Schema.Any)(output).pipe(
        Effect.catchEager((e) =>
          Effect.fail(
            new CapabilityError({
              extensionId,
              capabilityId,
              reason: `output validation failed: ${String(e)}`,
            }),
          ),
        ),
      )
      return output
    })

  return { entries, run, listForAudience }
}
