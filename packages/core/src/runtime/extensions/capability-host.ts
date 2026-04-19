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
  type CapabilityCoreContext,
  type Intent,
} from "../../domain/capability.js"
import { SCOPE_PRECEDENCE } from "./disabled.js"

interface RegisteredCapability {
  readonly extensionId: string
  readonly capability: AnyCapabilityContribution
}

/** Wide-only keys present on `ModelCapabilityContext` (extends
 *  `ExtensionHostContext`) but absent from `CapabilityCoreContext`. A handler
 *  authored against the wide shape that reaches for any of these on a narrow
 *  ctx is the bug class codex flagged on C4.5. */
const WIDE_ONLY_CTX_KEYS = new Set<string>([
  "extension",
  "extensions",
  "agent",
  "session",
  "interaction",
  "tools",
  "modality",
])

/** Wrap a narrow `CapabilityCoreContext` so a handler that mistakenly reads
 *  a wide-only key (e.g., `ctx.extension`) gets a clear, well-located error
 *  instead of a `Cannot read properties of undefined` runtime crash. The
 *  proxy is transparent for keys that genuinely exist on the narrow ctx. */
const narrowCtxGuard = (
  ctx: CapabilityCoreContext,
  extensionId: string,
  capabilityId: string,
): CapabilityContext =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  new Proxy(ctx as object, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && WIDE_ONLY_CTX_KEYS.has(prop)) {
        throw new Error(
          `Capability ${extensionId}/${capabilityId} (non-"model" audience) tried to access wide-context key "${prop}" — non-model dispatch passes a CapabilityCoreContext that does not include this key. Author the handler against CapabilityCoreContext or add "model" to the audiences list.`,
        )
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as CapabilityContext

/** Per-call options for `CompiledCapabilities.run`. */
export interface CapabilityRunOptions {
  /** If supplied, the resolved Capability MUST also have a matching `intent`
   *  — otherwise the call rejects with `CapabilityNotFoundError`. Pass
   *  `undefined` ONLY when the caller genuinely accepts both intents (e.g.,
   *  an internal admin path); typical callers pass `"read"` or `"write"` to
   *  prevent a same-id write capability from being invoked through a
   *  read-only entry point and vice versa (codex HIGH on C4.5: dropping the
   *  intent gate let `query()` invoke a write capability and `mutate()`
   *  invoke a read capability if their ids matched). */
  readonly intent?: Intent
}

export interface CompiledCapabilities {
  readonly entries: ReadonlyArray<RegisteredCapability>
  /** Run a Capability by `(extensionId, capabilityId)` from a given audience
   *  (and optionally a required intent).
   *
   *  Validates input + output via Schema. Rejects with
   *  `CapabilityNotFoundError` when the Capability is not registered, the
   *  registered Capability does not include the requested audience, or — when
   *  `options.intent` is supplied — the registered Capability's `intent` does
   *  not match. */
  readonly run: (
    extensionId: string,
    capabilityId: string,
    audience: Audience,
    input: unknown,
    // Accept the narrow `CapabilityCoreContext` shape so RPC entry points
    // (query/mutation via `agent-protocol` audience) can dispatch without
    // assembling the full `ModelCapabilityContext` (which only makes sense
    // for the model audience). Handlers that ask for the wider
    // `ModelCapabilityContext` will get their structurally-narrower view at
    // the type level — calls into model-only surfaces (e.g.
    // `ctx.interaction.approve`) on a narrow ctx fail to compile.
    ctx: CapabilityContext | CapabilityCoreContext,
    options?: CapabilityRunOptions,
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

  /** Identity-resolve, then check audience + (optional) intent authorization
   *  on the winner. Identity-first per the C4.1 codex BLOCK: a higher-scope
   *  registration shadows lower-scope same-id contributions even when the
   *  higher entry fails authorization — otherwise a project override could
   *  narrow audiences/intent but the lower-scope contribution would still
   *  leak through. */
  const findEntry = (
    extensionId: string,
    capabilityId: string,
    audience: Audience,
    requiredIntent: Intent | undefined,
  ): RegisteredCapability | undefined => {
    const winner = resolveByIdentity(extensionId, capabilityId)
    if (winner === undefined) return undefined
    if (!winner.capability.audiences.includes(audience)) return undefined
    if (requiredIntent !== undefined && winner.capability.intent !== requiredIntent)
      return undefined
    return winner
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

  const run: CompiledCapabilities["run"] = (
    extensionId,
    capabilityId,
    audience,
    input,
    ctx,
    options,
  ) =>
    Effect.gen(function* () {
      const entry = findEntry(extensionId, capabilityId, audience, options?.intent)
      if (entry === undefined) {
        return yield* new CapabilityNotFoundError({ extensionId, capabilityId })
      }
      // Codex MEDIUM on C4.5: handlers' ctx parameter is typed `CapabilityContext`
      // (alias for the wide `ModelCapabilityContext`), so a handler authored
      // for the wide shape can be invoked with a narrow `CapabilityCoreContext`
      // by an `agent-protocol` RPC and crash on `ctx.extension`/`ctx.session`/etc.
      // A proper fix is to split capability shapes (model vs non-model) at the
      // type level — out of scope for this commit. Defensive runtime guard:
      // when the dispatch ctx lacks the wide-only `extension` key, intercept
      // access to wide-only keys and surface a clear, well-located error
      // instead of a "Cannot read properties of undefined" runtime crash.
      const isNarrow =
        !("extension" in ctx) || (ctx as { extension?: unknown }).extension === undefined
      const handlerCtx: CapabilityContext = isNarrow
        ? narrowCtxGuard(ctx, extensionId, capabilityId)
        : (ctx as CapabilityContext)
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
      // composition time; the host treats it as already-provided. `handlerCtx`
      // is the wide ctx for `audience: "model"` and a Proxy-guarded narrow
      // ctx for non-model dispatch (the guard surfaces a clear error if a
      // handler authored against the wide shape reaches for `ctx.extension`
      // etc.); type-level enforcement is deferred to the C7/C8 capability
      // surface reorganization.
      //
      // The handler-construction call itself can throw (the proxy guard
      // throws synchronously when a property access happens during effect
      // construction; `catchDefect` only sees runtime-side failures, not
      // synchronous construction throws). Wrap the call in `Effect.try` to
      // funnel both paths through the same `CapabilityError` translation.
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — capability R/E erased at registry boundary
      const handlerEffect = yield* Effect.try({
        try: () => {
          const e = entry.capability.effect(decodedInput, handlerCtx)
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          return e as Effect.Effect<unknown, CapabilityError>
        },
        catch: (e) =>
          new CapabilityError({
            extensionId,
            capabilityId,
            reason: `handler defect: ${String(e)}`,
          }),
      })
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
