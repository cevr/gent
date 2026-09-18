import {
  Clock,
  Context,
  Duration,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import {
  AuthMethod,
  DEFAULT_RETRY_POLICY,
  defineExtension,
  ExtensionHost,
  type ExtensionHostService,
  isRecord,
  isRecordArray,
  type ModelDriverContribution,
  ProviderAuthError,
  type ProviderAuthInfo,
  type ProviderAuthorizationResult,
  type ProviderHints,
} from "@gent/core/extensions/api"
import { GentPlatform } from "@gent/core/extensions/branch-tools"
import {
  type CredentialCache,
  type CredentialCacheCell,
  type CredentialCacheCellRef,
  EMPTY_CREDENTIAL_CELL,
  freshCredentials,
  freshEnoughAt,
  makeCredentialCache,
  readOptionalEnv,
  recoverUnauthorized,
  withHeaders,
} from "./providers.js"
import type { ChildProcessSpawner } from "effect/unstable/process"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel, Generated } from "@effect/ai-anthropic"
import type { HttpClientError } from "effect/unstable/http/HttpClientError"
import { BunServices } from "@effect/platform-bun"
import { Model as AiModel } from "effect/unstable/ai"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun.js"

// ── model config ────────────────────────────────────────────────────────────

/**
 * Per-model Anthropic configuration — beta flags, ccVersion, and
 * model-specific overrides. Counsel  — ports
 * `griffinmartin/opencode-claude-auth/src/model-config.ts` so beta
 * derivation lives in one place instead of being scattered across
 * `oauth.ts` (`DEFAULT_BETA_FLAGS`, `LONG_CONTEXT_BETAS`,
 * `getModelBetas` haiku/long-context heuristics) and `signing.ts`
 * (hard-coded `"2.1.80"`).
 *
 * The override table is matched first-match-wins by `String.includes`
 * against the lowercased model id — list more specific keys before
 * broader ones (e.g. `"opus-4-6"` before `"opus"`).
 *
 * @module
 */

interface ModelOverride {
  /** Beta flags to remove from the base list for this model. */
  readonly exclude?: ReadonlyArray<string>
  /** Beta flags to add for this model on top of the base list. */
  readonly add?: ReadonlyArray<string>
  /** Whether the model rejects the `output_config.effort` /
   *  `thinking.effort` knobs. */
  readonly disableEffort?: boolean
}

interface ModelConfig {
  readonly ccVersion: string
  readonly baseBetas: ReadonlyArray<string>
  readonly longContextBetas: ReadonlyArray<string>
  readonly modelOverrides: Record<string, ModelOverride>
}

/**
 * Single source of truth for Anthropic model billing / beta config.
 * Keep aligned with Claude Code's currently-advertised version + beta
 * set; reference at
 * `~/.cache/repo/griffinmartin/opencode-claude-auth/src/model-config.ts`.
 */
export const MODEL_CONFIG: ModelConfig = {
  ccVersion: "2.1.90",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
  ],
  longContextBetas: ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"],
  modelOverrides: {
    haiku: {
      exclude: ["interleaved-thinking-2025-05-14"],
      disableEffort: true,
    },
    "4-6": {
      add: ["effort-2025-11-24"],
    },
    "4-7": {
      add: ["effort-2025-11-24"],
    },
  },
}

/**
 * First-match-wins lookup against the override table. Keys match by
 * `String.includes` against the lowercased model id; list more
 * specific keys before broader ones (e.g. `"opus-4-6"` before
 * `"opus"`) so the right override wins.
 */
export const getModelOverride = (modelId: string): Option.Option<ModelOverride> => {
  const lower = modelId.toLowerCase()
  for (const [pattern, override] of Object.entries(MODEL_CONFIG.modelOverrides)) {
    if (lower.includes(pattern)) return Option.some(override)
  }
  return Option.none()
}

/** Currently-advertised Claude Code CLI version, used by the billing
 *  signature. Override via `ANTHROPIC_CLI_VERSION` env var at the call
 *  site (kept here as the default for the helper). */
export const getCcVersion = (): string => MODEL_CONFIG.ccVersion

/**
 * Heuristic — does this model id look like opus/sonnet 4.6+ (the
 * versions where 1M-context is default)? Lifted from the opencode
 * reference; broader than a pure version bump because date-suffix
 * model ids (`-20250514`) get treated as `x.0`.
 */
export const supports1mContext = (modelId: string): boolean => {
  const lower = modelId.toLowerCase()
  if (!lower.includes("opus") && !lower.includes("sonnet")) return false
  const versionMatch = lower.match(/(opus|sonnet)-(\d+)-(\d+)/)
  const match = Option.fromNullishOr(versionMatch)
  if (Option.isNone(match)) return false
  const major = parseInt(
    Option.getOrElse(Option.fromNullishOr(match.value[2]), () => "0"),
    10,
  )
  const minor = parseInt(
    Option.getOrElse(Option.fromNullishOr(match.value[3]), () => "0"),
    10,
  )
  // Date suffixes like 20250514 are not minor versions — treat as x.0
  let effectiveMinor = minor
  if (minor > 99) effectiveMinor = 0
  return major > 4 || (major === 4 && effectiveMinor >= 6)
}

const applyModelOverride = (betas: Array<string>, override: Option.Option<ModelOverride>): void => {
  if (Option.isNone(override)) return
  const excludedBetas = Option.fromNullishOr(override.value.exclude)
  if (Option.isSome(excludedBetas)) {
    for (const excludedBeta of excludedBetas.value) {
      const index = betas.indexOf(excludedBeta)
      if (index !== -1) betas.splice(index, 1)
    }
  }
  const addedBetas = Option.fromNullishOr(override.value.add)
  if (Option.isSome(addedBetas)) {
    for (const addedBeta of addedBetas.value) {
      if (!betas.includes(addedBeta)) betas.push(addedBeta)
    }
  }
}

/**
 * Compose the beta list to send for a given model. Layered:
 *   1. base = `MODEL_CONFIG.baseBetas` (or env-override), comma-split.
 *   2. + first long-context beta when `supports1mContext(modelId)` is
 *      true (matches Claude CLI behavior — opt-in via the model id
 *      version, not a separate flag).
 *   3. apply per-model `exclude` / `add` from `getModelOverride`.
 *   4. drop anything in the optional `excluded` set (used by the
 *      long-context backoff path that retries with successive
 *      long-context betas removed).
 */
export const getModelBetas = (
  modelId: string,
  envBaseBetas: Option.Option<string>,
  excluded: Option.Option<ReadonlySet<string>> = Option.none(),
): ReadonlyArray<string> => {
  const baseRaw = Option.getOrElse(envBaseBetas, () => MODEL_CONFIG.baseBetas.join(","))
  const betas = baseRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (supports1mContext(modelId)) {
    const longContext = MODEL_CONFIG.longContextBetas[0]
    const longContextOption = Option.fromNullishOr(longContext)
    if (Option.isSome(longContextOption)) betas.push(longContextOption.value)
  }

  applyModelOverride(betas, getModelOverride(modelId))

  if (Option.isSome(excluded) && excluded.value.size > 0) {
    return betas.filter((beta) => !excluded.value.has(beta))
  }
  return betas
}

// ── platform adapter ────────────────────────────────────────────────────────

type ExtensionHostProcess = ExtensionHostService["Process"]

/**
 * Env vars for Anthropic keychain, read once at extension setup and
 * carried alongside platform inputs. Previously a module-level `let
 * _env`; promoted onto the platform shape so each extension instance
 * carries its own snapshot.
 */
export interface AnthropicKeychainEnv {
  readonly betaFlags?: string
  readonly cliVersion?: string
  readonly entrypoint?: string
  readonly userAgent?: string
}

const makeAnthropicKeychainEnv = (options: {
  readonly betaFlags: Option.Option<string>
  readonly cliVersion: Option.Option<string>
  readonly entrypoint: Option.Option<string>
  readonly userAgent: Option.Option<string>
}): AnthropicKeychainEnv => {
  let env: AnthropicKeychainEnv = {}
  if (Option.isSome(options.betaFlags)) env = { ...env, betaFlags: options.betaFlags.value }
  if (Option.isSome(options.cliVersion)) env = { ...env, cliVersion: options.cliVersion.value }
  if (Option.isSome(options.entrypoint)) env = { ...env, entrypoint: options.entrypoint.value }
  if (Option.isSome(options.userAgent)) env = { ...env, userAgent: options.userAgent.value }
  return env
}

interface AnthropicPlatformApi {
  readonly platform: string
  readonly home: string
  readonly parentEnv: ExtensionHostProcess["parentEnv"]
  readonly runProcess: ExtensionHostProcess["runProcess"]
  readonly env: AnthropicKeychainEnv
}

export class AnthropicPlatform extends Context.Service<AnthropicPlatform, AnthropicPlatformApi>()(
  "@gent/extensions/src/anthropic/AnthropicPlatform",
) {
  /**
   * Build from the `ExtensionHost` seen during setup. `home` is sourced from
   * `host.homeDirectory` (the OS user home), not `ctx.home` (the Gent
   * configured home) — the Claude Code credential file lives at the OS
   * user's home regardless of a `GENT_HOME` override, and earlier
   * refactors regressed this exactly once. Centralizing the lookup here
   * means future callers can't pick the wrong field.
   */
  static readonly fromSetup = (
    ctx: Pick<ExtensionHostService, "host" | "Process">,
    env: AnthropicKeychainEnv,
  ): AnthropicPlatformApi =>
    AnthropicPlatform.of({
      platform: ctx.host.osInfo.platform,
      home: ctx.host.homeDirectory,
      parentEnv: ctx.Process.parentEnv,
      runProcess: ctx.Process.runProcess,
      env,
    })
}

// ── signing ─────────────────────────────────────────────────────────────────

/**
 * Claude Code billing-header signing.
 *
 * Anthropic validates OAuth-authenticated requests against a per-message
 * billing signature. The signature lives in `system[0]` (NOT an HTTP
 * header) and encodes:
 *
 *   x-anthropic-billing-header:
 *     cc_version=<version>.<3-hex suffix>;
 *     cc_entrypoint=<entrypoint>;
 *     cch=<5-hex hash of first user message text>;
 *
 * Both hashes are computed from the raw text of the FIRST user message —
 * matching Claude Code's `K19()` extractor. A wrong `cch` (e.g. the
 * placeholder we shipped before this module) trips the validation and
 * surfaces as an `InvalidKey` error from the SDK.
 *
 * Constants and algorithm reverse-engineered by
 * `griffinmartin/opencode-claude-auth` from the Claude Code CLI; both
 * the salt and the format are stable across CLI versions in the field.
 *
 * @module
 */

const BILLING_SALT = "59cf53e54c78"

const MessageBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
})
const MessageContent = Schema.Union([Schema.String, Schema.Array(MessageBlock)])
const Message = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(MessageContent),
})
const decodeMessages = Schema.decodeUnknownOption(Schema.Array(Message))
const decodeTextContent = Schema.decodeUnknownOption(Schema.String)
const decodeBlockContent = Schema.decodeUnknownOption(Schema.Array(MessageBlock))

/**
 * Pull the text of the first user message's first text block — exactly
 * the input Claude Code's `K19()` hashes. Returns the empty string when
 * no user message or no text content is present (matching Claude Code's
 * fallback so the hash stays stable on no-input requests).
 */
export const extractFirstUserMessageText = (messages: ReadonlyArray<object>): string =>
  decodeMessages(messages).pipe(
    Option.flatMap((decoded) =>
      Option.fromNullishOr(decoded.find((message) => message.role === "user")),
    ),
    Option.flatMap((message) => Option.fromNullishOr(message.content)),
    Option.flatMap((content) => {
      const text = decodeTextContent(content)
      if (Option.isSome(text)) return text
      return decodeBlockContent(content).pipe(
        Option.flatMap((blocks) =>
          Option.fromNullishOr(blocks.find((block) => block.type === "text")),
        ),
        Option.flatMap((block) => Option.fromNullishOr(block.text)),
      )
    }),
    Option.getOrElse(() => ""),
  )

/**
 * Compute `cch` — first 5 hex chars of `sha256(messageText)`. The
 * Anthropic billing-validation step rejects requests whose `cch`
 * doesn't match the first user message we send, so this MUST be
 * recomputed per request (the previous hardcoded `c5e82` placeholder
 * worked exactly once, by accident).
 */
export const computeCch = (messageText: string): Effect.Effect<string, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    return platform.hash("sha256", messageText).slice(0, 5)
  })

/**
 * Compute the 3-char version suffix appended to `cc_version`. Samples
 * characters at indices 4, 7, 20 of the message text (zero-padded when
 * the message is shorter), prepends the billing salt + version string,
 * then hashes the lot. Anthropic checks this against the version we
 * advertise in the same header.
 */
export const computeVersionSuffix = (
  messageText: string,
  version: string,
): Effect.Effect<string, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const sampled = [4, 7, 20]
      .map((index) => Option.getOrElse(Option.fromNullishOr(messageText[index]), () => "0"))
      .join("")
    const input = `${BILLING_SALT}${sampled}${version}`
    return platform.hash("sha256", input).slice(0, 3)
  })

/**
 * Build the full billing-header value for insertion as `system[0]`.
 * Format matches Claude Code byte-for-byte; do not reorder fields or
 * change the trailing semicolons — the validator is strict.
 */
export const buildBillingHeaderValue = (
  messages: ReadonlyArray<object>,
  version: string,
  entrypoint: string,
): Effect.Effect<string, never, GentPlatform> =>
  Effect.gen(function* () {
    const text = extractFirstUserMessageText(messages)
    const suffix = yield* computeVersionSuffix(text, version)
    const cch = yield* computeCch(text)
    return (
      `x-anthropic-billing-header: ` +
      `cc_version=${version}.${suffix}; ` +
      `cc_entrypoint=${entrypoint}; ` +
      `cch=${cch};`
    )
  })

// ── beta cache ──────────────────────────────────────────────────────────────

/**
 * AnthropicBetaCache — cross-request learning cache for "betas the
 * server rejected for this model".
 *
 * This isn't just per-request retry state — it's session-level memory
 * so that turn N+1 doesn't include a beta turn N already learned the
 * server hates. Was module-global state in `oauth.ts` (deleted in
 * Commit 4). Now a service so it composes through Layer instead of
 * import-time mutable state, and so tests don't have to thread
 * `initAnthropicKeychainEnv` to reset between runs.
 *
 * Two implicit clear conditions, both ported verbatim:
 *   1. `betaFlags` env changes — user toggled flags, prior learning
 *      may no longer apply.
 *   2. `modelId` changes — different model, different beta surface.
 *
 * `getExcluded` takes `currentBetaFlags` as a parameter (not yielded
 * from a hidden module). Production wiring passes `_env.betaFlags` from
 * `oauth.ts`; tests can pass anything they want. No global mutation.
 */

// ── Internal cache cell ──

export interface BetaCacheCell {
  readonly map: ReadonlyMap<string, ReadonlySet<string>>
  readonly lastBetaFlags: Option.Option<string>
  readonly lastModelId: Option.Option<string>
}

export const EMPTY_BETA_CELL: BetaCacheCell = {
  map: new Map(),
  lastBetaFlags: Option.none(),
  lastModelId: Option.none(),
}

const cellAfterMaybeClear = (
  cell: BetaCacheCell,
  currentBetaFlags: Option.Option<string>,
  modelId: string,
): BetaCacheCell => {
  // Env betaFlags changed → clear everything. (Note: prior shape
  // tracked `lastBetaFlagsEnv` separately; here it's part of the cell.)
  if (!Equal.equals(cell.lastBetaFlags, currentBetaFlags)) {
    return { map: new Map(), lastBetaFlags: currentBetaFlags, lastModelId: Option.some(modelId) }
  }
  // Model changed → clear (prior shape only cleared when lastModelId
  // was already set, but the result is identical because the very
  // first request also has nothing to clear).
  if (Option.isSome(cell.lastModelId) && cell.lastModelId.value !== modelId) {
    return { map: new Map(), lastBetaFlags: currentBetaFlags, lastModelId: Option.some(modelId) }
  }
  return { ...cell, lastModelId: Option.some(modelId) }
}

// ── Service interface ──

export interface AnthropicBetaCacheApi {
  /**
   * Get the set of betas previously learned to be rejected for `modelId`
   * under the current `betaFlags` env. Auto-clears the entire cache if
   * either the env flags or the model differs from the last call.
   */
  readonly getExcluded: (
    modelId: string,
    currentBetaFlags: Option.Option<string>,
  ) => Effect.Effect<ReadonlySet<string>>
  /**
   * Record that `beta` was rejected for `modelId` under the current
   * `betaFlags` env. Runs the same env/model-change clear logic as
   * `getExcluded` so the call is standalone-safe (no hidden ordering
   * contract).
   */
  readonly recordExcluded: (
    modelId: string,
    beta: string,
    currentBetaFlags: Option.Option<string>,
  ) => Effect.Effect<void>
}

// ── Service tag ──

export class AnthropicBetaCache extends Context.Service<
  AnthropicBetaCache,
  AnthropicBetaCacheApi
>()("@gent/extensions/src/anthropic/AnthropicBetaCache") {
  static layer: Layer.Layer<AnthropicBetaCache> = Layer.effect(
    AnthropicBetaCache,
    Effect.gen(function* () {
      const cellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
      return AnthropicBetaCache.buildService(cellRef)
    }),
  )

  /**
   * Counsel  fix: cell Ref provided externally so the cache can live
   * for the extension lifetime instead of being rebuilt for every
   * `resolveModel` call. Without this, cross-request beta learning is
   * lost — a beta the server rejected on turn N would still appear on
   * turn N+1 because the rebuild zeros the map.
   */
  static layerFromRef = (cellRef: Ref.Ref<BetaCacheCell>): Layer.Layer<AnthropicBetaCache> =>
    Layer.succeed(AnthropicBetaCache, AnthropicBetaCache.buildService(cellRef))

  private static buildService = (cellRef: Ref.Ref<BetaCacheCell>): AnthropicBetaCacheApi => {
    const getExcluded = (
      modelId: string,
      currentBetaFlags: Option.Option<string>,
    ): Effect.Effect<ReadonlySet<string>> =>
      Ref.modify(cellRef, (cell) => {
        const next = cellAfterMaybeClear(cell, currentBetaFlags, modelId)
        const excluded = Option.getOrElse(
          Option.fromNullishOr(next.map.get(modelId)),
          () => new Set<string>(),
        )
        return [excluded, next]
      })

    const recordExcluded = (
      modelId: string,
      beta: string,
      currentBetaFlags: Option.Option<string>,
    ): Effect.Effect<void> =>
      Ref.update(cellRef, (cell) => {
        // Apply the same clear/seed transition as getExcluded so the
        // call is standalone-safe — no hidden contract that
        // recordExcluded must follow a getExcluded.
        const seeded = cellAfterMaybeClear(cell, currentBetaFlags, modelId)
        const existing = Option.getOrElse(
          Option.fromNullishOr(seeded.map.get(modelId)),
          () => new Set<string>(),
        )
        const updated = new Set(existing)
        updated.add(beta)
        const nextMap = new Map(seeded.map)
        nextMap.set(modelId, updated)
        return { ...seeded, map: nextMap }
      })

    return AnthropicBetaCache.of({ getExcluded, recordExcluded })
  }
}

// ── oauth credentials ───────────────────────────────────────────────────────

export const ClaudeCredentials = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Finite,
})

const ClaudeCredentialsWrapper = Schema.Struct({
  claudeAiOauth: ClaudeCredentials,
})

const CredentialBlobSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeCredentialBlob = Schema.decodeUnknownOption(Schema.fromJsonString(CredentialBlobSchema))

const OAuthTokenResponseSchema = Schema.Struct({
  access_token: Schema.OptionFromOptional(Schema.String),
  refresh_token: Schema.OptionFromOptional(Schema.String),
  expires_in: Schema.OptionFromOptional(Schema.Finite),
})
const decodeOAuthTokenResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(OAuthTokenResponseSchema),
)

export type ClaudeCredentials = typeof ClaudeCredentials.Type

export const freshEnoughForUse = (creds: ClaudeCredentials, now: number): boolean =>
  freshEnoughAt(creds.expiresAt, now)

const decodeCredentials = (raw: string): Effect.Effect<ClaudeCredentials, ProviderAuthError> =>
  Schema.decodeEffect(Schema.fromJsonString(ClaudeCredentialsWrapper))(raw).pipe(
    Effect.map((w) => w.claudeAiOauth),
    Effect.catchEager(() =>
      Schema.decodeEffect(Schema.fromJsonString(ClaudeCredentials))(raw).pipe(
        Effect.mapError(
          (e) =>
            new ProviderAuthError({
              message: "Invalid Claude credentials JSON",
              cause: e,
            }),
        ),
      ),
    ),
  )

/**
 * Splice fresh credentials into an existing keychain blob, preserving
 * any other fields (e.g. `subscriptionType`, `mcpOAuth`) so a write-back
 * doesn't blow away CLI state. Returns `None` if the blob isn't
 * valid JSON. Exported for testing.
 *
 * @internal
 */
export const updateCredentialBlob = (
  existingJson: string,
  newCreds: ClaudeCredentials,
): Option.Option<string> => {
  const decoded = decodeCredentialBlob(existingJson)
  if (Option.isNone(decoded)) return Option.none()
  const parsed = decoded.value
  const wrapperValue = parsed["claudeAiOauth"]
  const wrapper = Schema.decodeUnknownOption(CredentialBlobSchema)(wrapperValue)
  const credentialFields = {
    accessToken: newCreds.accessToken,
    refreshToken: newCreds.refreshToken,
    expiresAt: newCreds.expiresAt,
  }
  let next: typeof parsed = { ...parsed, ...credentialFields }
  if (Option.isSome(wrapper)) {
    next = { ...parsed, claudeAiOauth: { ...wrapper.value, ...credentialFields } }
  }
  return Option.some(Schema.encodeSync(Schema.fromJsonString(CredentialBlobSchema))(next))
}

/**
 * Parse a raw OAuth refresh response body into `ClaudeCredentials`.
 * Returns `None` if the body is not valid JSON, not an object,
 * or missing `access_token`. Defaults `expires_in` to 36 000s (10h) per
 * Anthropic's observed token lifetime. Exported for testing.
 *
 * @internal
 */
export const parseOAuthResponse = (
  raw: string,
  fallbackRefreshToken: string,
  now: number = 0,
): Option.Option<ClaudeCredentials> => {
  const decoded = decodeOAuthTokenResponse(raw)
  if (Option.isNone(decoded)) return Option.none()
  const data = decoded.value
  if (Option.isNone(data.access_token)) return Option.none()
  const expiresIn = Option.getOrElse(data.expires_in, () => 36_000)
  return Option.some({
    accessToken: data.access_token.value,
    refreshToken: Option.getOrElse(data.refresh_token, () => fallbackRefreshToken),
    expiresAt: now + expiresIn * 1000,
  })
}

// ── oauth anthropic headers ─────────────────────────────────────────────────

export const isLongContextError = (responseBody: string): boolean =>
  responseBody.includes("Extra usage is required for long context requests") ||
  responseBody.includes("long context beta is not yet available")

/**
 * Long-context backoff candidates — only the long-context betas that
 * actually appear in this model's effective header. Counsel deep
 * surfaced two related defects in the prior shape:
 *   1. We walked `LONG_CONTEXT_BETAS` directly, ignoring per-model
 *      overrides — so a haiku request (which excludes
 *      `interleaved-thinking-2025-05-14` via the override) would still
 *      "exclude" it on backoff, burning a retry on a beta that wasn't
 *      sent.
 *   2. The retry budget at the call site was `length - 1`, so the
 *      second exclusion attempt never went on the wire.
 * Both are fixed by deriving candidates from the model's actual
 * outgoing betas and giving each one a retry slot.
 */
const getLongContextBetasForWith = (
  modelId: string,
  currentBetaFlags: Parameters<typeof getModelBetas>[1],
): ReadonlyArray<string> => {
  const modelBetas = new Set(getModelBetas(modelId, currentBetaFlags))
  return MODEL_CONFIG.longContextBetas.filter((beta) => modelBetas.has(beta))
}

export const SYSTEM_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

/**
 * CLI version: the live env wins, otherwise the `MODEL_CONFIG.ccVersion`
 * baseline. Pure function — env comes from the caller's `AnthropicPlatform`.
 */
const getCliVersion = (env: AnthropicKeychainEnv): string => env.cliVersion ?? getCcVersion()

const getUserAgent = (env: AnthropicKeychainEnv): string =>
  env.userAgent ?? `claude-cli/${getCliVersion(env)} (external, cli)`

/**
 * Inputs the billing-header builder needs (CLI version + entrypoint).
 * The actual header text is built in `signing.ts` per request because
 * both hashes depend on the live first-user-message text.
 */
const getBillingHeaderInputs = (env: AnthropicKeychainEnv) => ({
  version: getCliVersion(env),
  entrypoint: env.entrypoint ?? "cli",
})

/**
 * Pull the `model` field from a JSON request body. Returns "unknown"
 * for missing/non-string bodies or unparseable JSON. Pure — both the
 * request pipelines read this from their respective request shapes (string
 * body / Uint8Array body) and call this helper to derive the model id used for
 * header construction.
 */
const ModelRequestBody = Schema.Struct({ model: Schema.String })
const decodeModelRequestBody = Schema.decodeUnknownOption(Schema.fromJsonString(ModelRequestBody))

const parseModelIdFromBody = (bodyText: Option.Option<string>): string =>
  bodyText.pipe(
    Option.filter((text) => text.length > 0),
    Option.flatMap(decodeModelRequestBody),
    Option.map((body) => body.model),
    Option.getOrElse(() => "unknown"),
  )

// ── oauth credentials file ──────────────────────────────────────────────────

const credentialsFilePath = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(home, ".claude", ".credentials.json")
  })

const readCredentialsFile: Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError,
  AnthropicPlatform | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const platform = yield* AnthropicPlatform
  const fs = yield* FileSystem.FileSystem
  const credentialsFile = yield* credentialsFilePath(platform.home)
  const exists = yield* fs.exists(credentialsFile).pipe(
    Effect.mapError(
      (e) =>
        new ProviderAuthError({
          message: `Failed to read Claude credentials file: ${e.message}`,
          cause: e,
        }),
    ),
  )
  if (!exists) {
    return yield* new ProviderAuthError({
      message: `Failed to read Claude credentials file: Credentials file not found: ${credentialsFile}`,
    })
  }
  const raw = yield* fs.readFileString(credentialsFile).pipe(
    Effect.mapError(
      (e) =>
        new ProviderAuthError({
          message: `Failed to read Claude credentials file: ${e.message}`,
          cause: e,
        }),
    ),
  )
  return yield* decodeCredentials(raw)
})

const writeCredentialsFile = (
  creds: ClaudeCredentials,
): Effect.Effect<void, ProviderAuthError, AnthropicPlatform | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    const fs = yield* FileSystem.FileSystem
    const credentialsFile = yield* credentialsFilePath(platform.home)
    const mapFsError = (e: { readonly message: string }) =>
      new ProviderAuthError({
        message: `Failed to write Claude credentials file: ${e.message}`,
        cause: e,
      })
    const exists = yield* fs.exists(credentialsFile).pipe(Effect.mapError(mapFsError))
    let raw = '{"claudeAiOauth":{}}'
    if (exists) {
      raw = yield* fs.readFileString(credentialsFile).pipe(Effect.mapError(mapFsError))
    }
    const updated = updateCredentialBlob(raw, creds)
    if (Option.isNone(updated)) return
    yield* fs.writeFileString(credentialsFile, updated.value).pipe(Effect.mapError(mapFsError))
    // Counsel  deep — chmod 0600 after write so the credentials
    // file isn't world-readable on first creation. Matches the
    // opencode reference's keychain.ts:297 behavior.
    yield* platform.runProcess("chmod", ["600", credentialsFile], { stdout: "ignore" }).pipe(
      Effect.mapError(
        (e) =>
          new ProviderAuthError({
            message: `Failed to write Claude credentials file: ${e.message}`,
            cause: e,
          }),
      ),
    )
  })

// ── oauth keychain ──────────────────────────────────────────────────────────

/**
 * Default keychain service name and on-disk file path. Counsel K2
 * called out that hard-coding the primary service silently broke any
 * future multi-account UI consumer — every credential helper now takes
 * an explicit `source` so callers spell out which account they mean.
 */
export const PRIMARY_CLAUDE_SERVICE = "Claude Code-credentials"

class ClaudeKeychainNotFoundError extends Schema.TaggedError<ClaudeKeychainNotFoundError>()(
  "ClaudeKeychainNotFoundError",
  {},
) {}

const spawnSecurity = (
  args: readonly string[],
): Effect.Effect<string, ProviderAuthError | ClaudeKeychainNotFoundError, AnthropicPlatform> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    const result = yield* platform
      .runProcess("security", args, { timeout: Duration.millis(5000) })
      .pipe(
        Effect.catchTag("ExtensionHostProcessError", (e) => {
          if (e.timedOut === true) {
            return Effect.fail(
              new ProviderAuthError({
                message: "Keychain read timed out. Try restarting Keychain Access.",
              }),
            )
          }
          return Effect.fail(
            new ProviderAuthError({
              message: `Failed to read Claude Code credentials from Keychain: ${e.message}`,
              cause: e,
            }),
          )
        }),
      )
    if (result.exitCode === 0) return result.stdout.trim()
    if (result.exitCode === 44) return yield* new ClaudeKeychainNotFoundError()
    if (result.exitCode === 36) {
      return yield* new ProviderAuthError({
        message:
          "macOS Keychain is locked. Unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db",
      })
    }
    if (result.exitCode === 128) {
      return yield* new ProviderAuthError({
        message: "Keychain access was denied. Grant access when prompted by macOS.",
      })
    }
    return yield* new ProviderAuthError({
      message: `Failed to read Claude Code credentials from Keychain: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    })
  })

const readFromKeychain = (
  source: string,
): Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError | ClaudeKeychainNotFoundError,
  AnthropicPlatform
> =>
  spawnSecurity(["find-generic-password", "-s", source, "-w"]).pipe(
    Effect.flatMap(decodeCredentials),
  )

/**
 * Pure policy: should a keychain miss for `source` fall back to the
 * on-disk credentials file? Only when we're not on darwin (no
 * keychain at all) or the request is for the primary account. For
 * non-primary sources on darwin, source means source — silently
 * returning the disk credential would leak the primary into a
 * multi-account picker.
 *
 * Exported so the policy can be unit-tested without spawning
 * `security`. Counsel  review surfaced this as a real defect.
 */
export const shouldFallBackToCredentialsFile = (platform: string, source: string): boolean =>
  platform !== "darwin" || source === PRIMARY_CLAUDE_SERVICE

/**
 * Pure policy: when direct OAuth refresh fails, should we spawn the
 * `claude` CLI as a fallback? Only safe for the primary source — the
 * CLI persists to whichever account it considers active, so a
 * non-primary spawn could refresh the wrong account.
 *
 * Exported so the policy can be unit-tested without spawning a
 * subprocess. Counsel  review.
 */
export const shouldFallBackToCli = (source: string): boolean => source === PRIMARY_CLAUDE_SERVICE

/**
 * Discover the macOS username stored on a keychain entry. The Claude
 * CLI uses the user's account name (e.g. "alice") as the keychain
 * `acct` field, NOT the service name. Writing with the wrong `acct`
 * creates a duplicate entry instead of updating the existing one —
 * exactly the bug `griffinmartin/opencode-claude-auth` ran into.
 */
const getKeychainAccountName = (
  serviceName: string,
): Effect.Effect<Option.Option<string>, never, AnthropicPlatform> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    return yield* platform
      .runProcess("security", ["find-generic-password", "-s", serviceName], {
        timeout: Duration.millis(2000),
      })
      .pipe(
        Effect.map((result) => {
          const match = /"acct"<blob>="([^"]*)"/.exec(result.stdout)
          return Option.fromNullishOr(match?.[1])
        }),
        Effect.catchEager(() => Effect.succeedNone),
      )
  })

const writeKeychainEntry = (
  serviceName: string,
  accountName: string,
  payload: string,
): Effect.Effect<void, ProviderAuthError, AnthropicPlatform> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    return yield* platform
      .runProcess(
        "security",
        ["add-generic-password", "-s", serviceName, "-a", accountName, "-w", payload, "-U"],
        { timeout: Duration.millis(2000), stdout: "ignore" },
      )
      .pipe(
        Effect.flatMap((result) => {
          if (result.exitCode === 0) return Effect.void
          return Effect.fail(
            new ProviderAuthError({
              message: `Failed to write Claude credentials to Keychain: ${result.stderr.trim() || `security add-generic-password exit ${result.exitCode}`}`,
            }),
          )
        }),
        Effect.catchTag("ExtensionHostProcessError", (e) =>
          Effect.fail(
            new ProviderAuthError({
              message: `Failed to write Claude credentials to Keychain: ${e.message}`,
              cause: e,
            }),
          ),
        ),
      )
  })

// ── oauth accounts ──────────────────────────────────────────────────────────

/**
 * Read Claude Code credentials for `source` (the keychain service name).
 * Use `PRIMARY_CLAUDE_SERVICE` for the default account.
 *
 * On non-darwin (no keychain), `source` is ignored and the on-disk
 * `.credentials.json` is read instead — that file holds only one
 * credential, mirroring the CLI's behaviour.
 *
 * On darwin, the on-disk fallback is gated to PRIMARY only. A
 * non-primary keychain miss propagates `ProviderAuthError` rather
 * than silently returning the disk credential as if it belonged to
 * the requested source.
 */
const readClaudeCodeCredentials = (
  source: string,
): Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    if (platform.platform !== "darwin") {
      return yield* readCredentialsFile
    }
    return yield* readFromKeychain(source).pipe(
      Effect.catchIf(Schema.is(ClaudeKeychainNotFoundError), () => {
        if (shouldFallBackToCredentialsFile(platform.platform, source)) {
          return readCredentialsFile
        }
        return Effect.fail(
          new ProviderAuthError({
            message: `No Claude credentials found in keychain for source: ${source}`,
          }),
        )
      }),
    )
  })

/**
 * Persist refreshed credentials back to the keychain entry named by
 * `source` (or `~/.claude/.credentials.json` on non-darwin). Without
 * this, every direct OAuth refresh is wasted — the next read pulls
 * the stale `accessToken` straight back from disk/keychain. The
 * `acct` field is preserved by reading the existing entry first.
 *
 * Errors are surfaced as `ProviderAuthError` for the caller to log
 * (per : write-back is best-effort; the in-memory creds are
 * authoritative for the in-flight request).
 */
const writeBackCredentials = (
  creds: ClaudeCredentials,
  source: string,
): Effect.Effect<
  void,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    if (platform.platform !== "darwin") {
      return yield* writeCredentialsFile(creds)
    }

    // Counsel  deep — surface the read failure as a typed error
    // instead of swallowing it into "" and silently returning success.
    // The previous shape bypassed the warn-on-failure path at the
    // refresh call site, so a keychain read fault during write-back
    // looked indistinguishable from a successful update.
    //
    // ClaudeKeychainNotFoundError is mapped to a ProviderAuthError so
    // the public signature stays narrow — write-back callers use a
    // best-effort `catchEager` that doesn't need to know about the
    // internal not-found tag.
    const raw = yield* spawnSecurity(["find-generic-password", "-s", source, "-w"]).pipe(
      Effect.catchIf(Schema.is(ClaudeKeychainNotFoundError), () =>
        Effect.fail(
          new ProviderAuthError({
            message: `Cannot write back: no keychain entry for source: ${source}`,
          }),
        ),
      ),
    )
    const updated = updateCredentialBlob(raw, creds)
    if (Option.isNone(updated)) return
    const accountName = Option.getOrElse(yield* getKeychainAccountName(source), () => source)
    yield* writeKeychainEntry(source, accountName, updated.value)
  })

// ── oauth refresh ───────────────────────────────────────────────────────────

/**
 * Anthropic's OAuth refresh endpoint and CLI client id. Discovered by
 * `griffinmartin/opencode-claude-auth` from the Claude Code CLI's
 * traffic; both values are public (the client id ships in every
 * `claude` install) so checking them in is safe.
 */
const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/**
 * Refresh the OAuth token by POSTing directly to Anthropic's OAuth
 * endpoint, then writing the new credentials back so the next
 * `readClaudeCodeCredentials` call sees them. Costs zero LLM tokens —
 * matches the path `griffinmartin/opencode-claude-auth` discovered.
 *
 * Falls back to `claude -p . --model haiku` (which triggers the CLI's own
 * refresh logic) when the direct refresh fails for any reason — auth-server
 * downtime, refresh-token revoked, schema change, etc.
 */
const refreshViaOAuth = (
  refreshToken: string,
): Effect.Effect<ClaudeCredentials, ProviderAuthError> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(OAUTH_TOKEN_URL).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    )
    const response = yield* http.execute(request)
    if (response.status >= 400) {
      const errText = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* new ProviderAuthError({
        message: `Direct OAuth refresh failed: ${response.status} ${errText}`,
      })
    }
    const body = yield* response.text
    const now = yield* Clock.currentTimeMillis
    const creds = parseOAuthResponse(body, refreshToken, now)
    if (Option.isNone(creds)) {
      return yield* new ProviderAuthError({
        message: "OAuth refresh response missing access_token",
      })
    }
    return creds.value
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catchEager((e) => {
      if (Schema.is(ProviderAuthError)(e)) return Effect.fail(e)
      let message = String(e)
      if (e instanceof Error) message = e.message
      return Effect.fail(
        new ProviderAuthError({
          message: `Direct OAuth refresh failed: ${message}`,
          cause: e,
        }),
      )
    }),
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(FetchHttpClient.layer),
  )

const spawnClaudeCli = (): Effect.Effect<
  void,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    const env = { ...platform.parentEnv, TERM: "dumb" }
    return yield* platform
      .runProcess("claude", ["-p", ".", "--model", "haiku"], {
        env,
        timeout: Duration.millis(60_000),
        stdout: "ignore",
        stderr: "ignore",
      })
      .pipe(
        Effect.flatMap((result) => {
          if (result.exitCode === 0) return Effect.void
          return Effect.fail(
            new ProviderAuthError({
              message: `Failed to refresh Claude Code credentials via CLI: claude CLI exited with code ${result.exitCode}`,
            }),
          )
        }),
        Effect.catchTag("ExtensionHostProcessError", (e) =>
          Effect.fail(
            new ProviderAuthError({
              message: `Failed to refresh Claude Code credentials via CLI: ${e.message}`,
              cause: e,
            }),
          ),
        ),
      )
  })

/**
 * Refresh the cached Claude Code credentials and return the fresh ones
 * directly to the caller. Tries the direct OAuth endpoint first (fast,
 * free); falls back to spawning `claude` (slow, costs Haiku tokens)
 * only if the direct path fails. The CLI fallback writes back via the
 * Claude binary itself; we re-read keychain afterwards.
 *
 * Crucially the caller MUST use the returned value rather than
 * re-reading keychain after the call. A void-returning shape would
 * silently lose direct-OAuth tokens whenever write-back failed
 * (locked keychain, file perms, race with `claude` CLI). Write-back
 * here is best-effort; the in-memory creds are authoritative for this
 * turn.
 */
const refreshClaudeCodeCredentials = (
  source: string,
): Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const current = yield* readClaudeCodeCredentials(source).pipe(Effect.option)
    if (Option.isSome(current) && current.value.refreshToken !== "") {
      const refreshed = yield* refreshViaOAuth(current.value.refreshToken).pipe(Effect.option)
      if (Option.isSome(refreshed)) {
        // Best-effort write-back so subsequent processes pick up the
        // new token. A failure here doesn't lose the refresh — the
        // caller has it in memory.
        yield* writeBackCredentials(refreshed.value, source).pipe(
          Effect.catchEager((e: ProviderAuthError) =>
            Effect.logWarning("anthropic.oauth.writeback.failed").pipe(
              Effect.annotateLogs({ error: String(e), source }),
            ),
          ),
        )
        return refreshed.value
      }
    }
    // Direct path failed — fall back to the CLI spawn (second attempt
    // historically helps when the first invocation kicks a stale-token
    // error). The CLI persists its own credentials to whichever
    // account it considers active, so this fallback is ONLY safe for
    // the primary source. For non-primary accounts a CLI spawn could
    // refresh the wrong account; surface a typed failure instead so
    // the picker can prompt the user to refresh that account
    // explicitly.
    if (!shouldFallBackToCli(source)) {
      return yield* new ProviderAuthError({
        message: `Direct OAuth refresh failed for ${source}; CLI fallback would target the active account, not this one. Refresh the account in Claude Code directly.`,
      })
    }
    yield* spawnClaudeCli().pipe(Effect.retry({ times: 1 }))
    return yield* readClaudeCodeCredentials(source)
  })

// ── credential service ──────────────────────────────────────────────────────

/**
 * AnthropicCredentialService — Claude Code credentials behind the shared
 * credential cache (`../provider-credentials.ts`).
 *
 * The keychain is the source of truth: once the cache TTL lapses the
 * service re-reads it, and only refreshes (OAuth or CLI fallback) when
 * the keychain holds nothing usable. Refreshed credentials are returned
 * directly — re-reading the keychain after refresh would silently lose
 * direct-OAuth tokens whenever write-back failed.
 */

// ── IO seam ──

type AnthropicCredentialIORequirements =
  | AnthropicPlatform
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path

type CredentialIO = Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError,
  AnthropicCredentialIORequirements
>

/** IO the service depends on, lifted out so tests can drive it without spawning `security` or touching the keychain. */
export interface AnthropicCredentialIO {
  /** Read currently-stored creds for the primary source. */
  readonly read: CredentialIO
  /** Refresh creds for the primary source via OAuth or CLI fallback. */
  readonly refresh: CredentialIO
}

// PRIMARY_CLAUDE_SERVICE is the only source wired here — the multi-account
// picker UI doesn't exist yet. Spelled out so an audit-grep finds every site.
const realIO: AnthropicCredentialIO = {
  read: readClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE),
  refresh: refreshClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE),
}

// ── Service tag ──

export class AnthropicCredentialService extends Context.Service<
  AnthropicCredentialService,
  CredentialCache<ClaudeCredentials>
>()("@gent/extensions/src/anthropic/AnthropicCredentialService") {
  /**
   * Production layer. The cache cell is provided externally so its
   * lifetime is hoisted above the per-`resolveModel` layer build; a Ref
   * allocated per build would disable the cache. `authInfo.persist`
   * (when present) durably writes refreshed credentials back to Auth.
   */
  static layerFromRef = (
    cellRef: CredentialCacheCellRef<ClaudeCredentials>,
    authInfo?: ProviderAuthInfo,
  ) => Layer.effect(AnthropicCredentialService, build(cellRef, realIO, authInfo))

  /** Test-friendly variant — accepts the IO seam so tests can drive read/refresh deterministically. */
  static layerFromIO = (io: AnthropicCredentialIO, authInfo?: ProviderAuthInfo) =>
    Layer.effect(
      AnthropicCredentialService,
      SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL).pipe(
        Effect.flatMap((cellRef) => build(cellRef, io, authInfo)),
      ),
    )
}

const build = (
  cellRef: CredentialCacheCellRef<ClaudeCredentials>,
  io: AnthropicCredentialIO,
  authInfo?: ProviderAuthInfo,
): Effect.Effect<CredentialCache<ClaudeCredentials>, never, AnthropicCredentialIORequirements> =>
  Effect.gen(function* () {
    const ioContext = yield* Effect.context<AnthropicCredentialIORequirements>()
    const read = io.read.pipe(Effect.provideContext(ioContext))
    const refresh = io.refresh.pipe(Effect.provideContext(ioContext))
    const cache = yield* makeCredentialCache({
      label: "Anthropic",
      credentials: ClaudeCredentials,
      cellRef,
      authInfo: Option.fromNullishOr(authInfo),
      seed: Option.none(),
      expiresAt: (creds) => creds.expiresAt,
      // A keychain miss surfaces as ProviderAuthError; swallowing it
      // turns the miss into a refresh attempt instead of a failure.
      read: () => Effect.option(read),
      refresh: () =>
        Effect.gen(function* () {
          const refreshed = yield* Effect.option(refresh)
          const now = yield* Clock.currentTimeMillis
          if (Option.isSome(refreshed) && freshEnoughForUse(refreshed.value, now)) {
            return refreshed.value
          }
          return yield* new ProviderAuthError({
            message:
              "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
          })
        }),
      toPersisted: (creds) => ({
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
      }),
    })
    return AnthropicCredentialService.of(cache)
  })

// ── keychain client ─────────────────────────────────────────────────────────

/**
 * AnthropicClient wrapper for Claude Code keychain mode.
 *
 * Intercepts createMessage/createMessageStream to apply:
 * - mcp_ tool name prefix on outgoing payloads
 * - mcp_ tool name strip on incoming responses
 * - System identity injection
 * - Cache control on system messages
 *
 * This keeps all Claude Code keychain conventions in the extension,
 * out of the generic provider boundary.
 */

type KeychainTransformRequirements = GentPlatform | AnthropicPlatform

// ── Constants ──

const MCP_PREFIX = "mcp_"
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header"
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
type JsonRecord = Schema.Schema.Type<typeof JsonRecordSchema>
const JsonValueSchema = Schema.Unknown
type JsonValue = Schema.Schema.Type<typeof JsonValueSchema>
const MessageStreamEventSchema = Schema.Union([
  Generated.BetaMessageStartEvent,
  Generated.BetaMessageDeltaEvent,
  Generated.BetaMessageStopEvent,
  Generated.BetaContentBlockStartEvent,
  Generated.BetaContentBlockDeltaEvent,
  Generated.BetaContentBlockStopEvent,
  Generated.BetaErrorResponse,
])
const decodeMessageStreamEvent = Schema.decodeUnknownSync(MessageStreamEventSchema)
const decodeMessagePayload = Schema.decodeUnknownSync(Generated.BetaCreateMessageParams)
const encodeMessagePayload = Schema.encodeUnknownSync(Generated.BetaCreateMessageParams)

// Counsel  — model-specific quirks (effort-disabled, etc.) live in
// `model-config.ts`'s `MODEL_OVERRIDES` table; we read them via
// `getModelOverride(modelId).disableEffort` rather than a prefix check
// hard-coded here.

// ── Payload Transforms (outgoing) ──

/**
 * Prefix tool names with `mcp_` AND uppercase the first letter — Claude
 * Code uses PascalCase tool names (`mcp_Bash`, `mcp_Read`); lowercase
 * names trip the Anthropic OAuth-billing validation when multiple tools
 * are present (verified in opencode-claude-auth issue notes).
 */
const prefixName = (name: string): string =>
  `${MCP_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`

/** Reverse `prefixName`: drop `mcp_` and lowercase the first char. */
const unprefixName = (name: string): string => {
  let stripped = name
  if (name.startsWith(MCP_PREFIX)) stripped = name.slice(MCP_PREFIX.length)
  return `${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}`
}

/** Prefix all tool names with mcp_ in the outgoing payload */
const transformTools = (tools: ReadonlyArray<JsonRecord>): ReadonlyArray<JsonRecord> =>
  tools.map((tool) => {
    if (!Predicate.isString(tool["name"])) return tool
    return { ...tool, name: prefixName(tool["name"]) }
  })

/** Prefix tool names in historical message content blocks (tool_use) */
const transformMessages = (messages: ReadonlyArray<JsonRecord>): ReadonlyArray<JsonRecord> =>
  messages.map((msg) => {
    if (!isRecordArray(msg["content"])) return msg
    return {
      ...msg,
      content: msg["content"].map((block: JsonRecord) => {
        if (block["type"] === "tool_use" && Predicate.isString(block["name"])) {
          return { ...block, name: prefixName(block["name"]) }
        }
        return block
      }),
    }
  })

/** Prefix tool name in tool_choice if it specifies a particular tool */
const transformToolChoice = (toolChoice: JsonValue): JsonValue => {
  if (!isRecord(toolChoice)) return toolChoice
  if (toolChoice["type"] === "tool" && Predicate.isString(toolChoice["name"])) {
    return { ...toolChoice, name: prefixName(toolChoice["name"]) } satisfies JsonRecord
  }
  return toolChoice
}

/**
 * Counsel  (opencode parity B) — drop orphan `tool_use` blocks (no
 * matching downstream `tool_result`) and orphan `tool_result` blocks
 * (no matching upstream `tool_use`) from message history. Anthropic
 * rejects requests with mismatched pairs (HTTP 400), and a partial turn
 * failure or mid-stream cancel can easily strand one half of a pair.
 *
 * After filtering, messages whose `content` array empties out are
 * dropped entirely so the API doesn't see `{ role, content: [] }`.
 */
type ToolPairIds = {
  readonly toolUseIds: ReadonlySet<string>
  readonly toolResultIds: ReadonlySet<string>
}

const collectToolPairIds = (messages: ReadonlyArray<JsonRecord>): ToolPairIds => {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const message of messages) {
    if (!isRecordArray(message["content"])) continue
    for (const block of message["content"]) {
      const id = block["id"]
      if (block["type"] === "tool_use" && Predicate.isString(id)) {
        toolUseIds.add(id)
      }
      const toolUseId = block["tool_use_id"]
      if (block["type"] === "tool_result" && Predicate.isString(toolUseId)) {
        toolResultIds.add(toolUseId)
      }
    }
  }

  return { toolUseIds, toolResultIds }
}

const findOrphanedIds = (
  ids: ReadonlySet<string>,
  matchingIds: ReadonlySet<string>,
): ReadonlySet<string> => {
  const orphaned = new Set<string>()
  for (const id of ids) {
    if (!matchingIds.has(id)) orphaned.add(id)
  }
  return orphaned
}

const filterToolPairMessage = (
  message: JsonRecord,
  orphanedUses: ReadonlySet<string>,
  orphanedResults: ReadonlySet<string>,
): Option.Option<JsonRecord> => {
  if (!isRecordArray(message["content"])) return Option.some(message)
  const next = message["content"].filter((block: JsonRecord) => {
    const id = block["id"]
    if (block["type"] === "tool_use" && Predicate.isString(id)) {
      return !orphanedUses.has(id)
    }
    const toolUseId = block["tool_use_id"]
    if (block["type"] === "tool_result" && Predicate.isString(toolUseId)) {
      return !orphanedResults.has(toolUseId)
    }
    return true
  })
  if (next.length === 0) return Option.none()
  return Option.some({ ...message, content: next })
}

/** Remove unpaired tool-use and tool-result blocks from message history. */
export const repairToolPairs = (messages: ReadonlyArray<JsonRecord>): ReadonlyArray<JsonRecord> => {
  const { toolUseIds, toolResultIds } = collectToolPairIds(messages)
  const orphanedUses = findOrphanedIds(toolUseIds, toolResultIds)
  const orphanedResults = findOrphanedIds(toolResultIds, toolUseIds)

  if (orphanedUses.size === 0 && orphanedResults.size === 0) return messages

  const filtered: JsonRecord[] = []
  for (const message of messages) {
    const next = filterToolPairMessage(message, orphanedUses, orphanedResults)
    if (Option.isSome(next)) filtered.push(next.value)
  }
  return filtered
}

/**
 * Coerce `system` (string | array | undefined) into the canonical block
 * array shape used by the rest of the pipeline. The downstream billing
 * + identity injection expects an array — string input is wrapped.
 */
const normalizeSystemBlocks = (system: JsonValue): ReadonlyArray<JsonRecord> =>
  Option.match(Option.fromNullishOr(system), {
    onNone: () => [],
    onSome: (value) => {
      if (Predicate.isString(value)) return [{ type: "text", text: value }]
      if (Array.isArray(value) && isRecordArray(value)) return value
      return []
    },
  })

/**
 * Drop any `system[]` entry that already carries a billing-header text
 * block — we re-compute the header per request from the live messages
 * so a stale entry from an earlier turn would otherwise sit alongside
 * the fresh one and confuse the validator.
 */
const stripExistingBillingBlocks = (blocks: ReadonlyArray<JsonRecord>): ReadonlyArray<JsonRecord> =>
  blocks.filter((block) => {
    const text = block["text"]
    return !(Predicate.isString(text) && text.startsWith(BILLING_HEADER_PREFIX))
  })

/**
 * Split caller-provided system blocks into the identity entry, billing
 * entries (always discarded — re-computed per-request), and everything
 * else (the movable third-party content). Used by the relocator to
 * decide what to pull into the first user message before billing is
 * computed.
 *
 * Counsel  deep — a single block carrying `IDENTITY + "\n\n<rest>"`
 * (the shape OpenCode's `system.transform` hook produces) used to
 * classify as identity-only and silently drop `<rest>`. Now we split
 * the block at the identity boundary: identity goes to identityBlocks,
 * the trailing remainder rides along as third-party so the relocator
 * pulls it into the first user message.
 */
type PartitionedSystemBlocks = {
  readonly identityBlocks: ReadonlyArray<JsonRecord>
  readonly thirdPartyBlocks: ReadonlyArray<JsonRecord>
}

const partitionSystemBlocks = (callerSystem: JsonValue): PartitionedSystemBlocks => {
  const blocks = stripExistingBillingBlocks(normalizeSystemBlocks(callerSystem))
  const identityBlocks: JsonRecord[] = []
  const thirdPartyBlocks: JsonRecord[] = []
  for (const block of blocks) {
    const text = block["text"]
    if (Predicate.isString(text) && text.startsWith(SYSTEM_IDENTITY_PREFIX)) {
      const rest = text.slice(SYSTEM_IDENTITY_PREFIX.length).replace(/^\n+/, "")
      const { text: _t, cache_control: _cc, ...rest_props } = block
      // Identity itself rides without cache_control (validator rejects
      // a marked identity block — counts toward the 4-block limit).
      identityBlocks.push({ ...rest_props, text: SYSTEM_IDENTITY_PREFIX })
      if (rest.length > 0) {
        // Remainder picks back up the original block's `cache_control`
        // and other props so users can still mark long instructions
        // for prompt caching.
        thirdPartyBlocks.push({ ...block, text: rest })
      }
    } else {
      thirdPartyBlocks.push(block)
    }
  }
  return { identityBlocks, thirdPartyBlocks }
}

/**
 * Build the final `system[]` array with the strict shape Anthropic's
 * OAuth billing validator expects:
 *
 *   [0] billing-header text block (no cache_control)
 *   [1] identity prefix text block (no cache_control)
 *
 * After  relocation there are no third-party blocks left to attach;
 * any third-party content was pulled into the first user message
 * before this builder ran. Identity must be its own entry —
 * concatenating it into another text block trips the validator
 * (opencode issue #98). The billing block MUST NOT carry cache_control:
 * Anthropic rejects requests exceeding 4 cache_control blocks per
 * request, and the billing entry would count toward that limit.
 *
 * Counsel  — caller MUST pass the FINAL post-relocation messages so
 * the billing hash matches the first-user text actually sent on the
 * wire. Computing the hash from pre-relocation messages produces a
 * stale digest and 400s.
 */
const buildSystemArray = (
  finalMessages: ReadonlyArray<JsonRecord>,
): Effect.Effect<ReadonlyArray<JsonRecord>, never, KeychainTransformRequirements> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    const { version, entrypoint } = getBillingHeaderInputs(platform.env)
    const billing = yield* buildBillingHeaderValue(finalMessages, version, entrypoint)

    return [
      { type: "text", text: billing },
      { type: "text", text: SYSTEM_IDENTITY_PREFIX },
    ]
  })

/**
 * Counsel  (opencode parity A) — Anthropic's OAuth-billing path
 * validates `system[]` against the Claude Code identity prefix.
 * Third-party system content alongside the prefix trips a 400 "out of
 * extra usage" rejection. The relocator takes the third-party blocks
 * (already partitioned by `partitionSystemBlocks`) and folds them into
 * the first user message as a single text block.
 *
 * Counsel  follow-up:
 *   - tool_result ordering: Anthropic requires tool_result blocks to be
 *     the FIRST blocks of a user message that carries any. Inserting
 *     text at index 0 in such a message produces 400. We splice the
 *     relocated text in AFTER the leading run of tool_result blocks.
 *   - billing freshness: this runs BEFORE buildSystemArray so the
 *     billing hash is computed from the FINAL first-user text. The
 *     pre-fix shape computed billing first, then mutated the message,
 *     so the wire hash didn't match the wire text.
 *
 * Returns the new messages array; mutates nothing.
 */
const relocateThirdPartyIntoFirstUser = (
  thirdPartyBlocks: ReadonlyArray<JsonRecord>,
  messages: ReadonlyArray<JsonRecord>,
): ReadonlyArray<JsonRecord> => {
  const movedTexts: string[] = []
  for (const block of thirdPartyBlocks) {
    const text = block["text"]
    if (Predicate.isString(text) && text.length > 0) movedTexts.push(text)
  }
  if (movedTexts.length === 0) return messages

  const firstUserIdx = messages.findIndex((m) => m["role"] === "user")
  if (firstUserIdx === -1) return messages

  const firstUser = Option.fromUndefinedOr(messages[firstUserIdx])
  if (Option.isNone(firstUser)) return messages
  const firstUserValue = firstUser.value
  const content = firstUserValue["content"]
  const prefix = movedTexts.join("\n\n")
  const nextMessages = messages.slice()

  if (Predicate.isString(content)) {
    nextMessages[firstUserIdx] = { ...firstUserValue, content: `${prefix}\n\n${content}` }
    return nextMessages
  }
  if (isRecordArray(content)) {
    // Find the index where leading tool_result blocks end. Inserting
    // text before that boundary trips Anthropic's "tool_result must
    // come first" check.
    let firstNonToolResult = 0
    while (
      firstNonToolResult < content.length &&
      content[firstNonToolResult]?.["type"] === "tool_result"
    ) {
      firstNonToolResult += 1
    }
    nextMessages[firstUserIdx] = {
      ...firstUserValue,
      content: [
        ...content.slice(0, firstNonToolResult),
        { type: "text", text: prefix },
        ...content.slice(firstNonToolResult),
      ],
    }
    return nextMessages
  }
  // Unknown content shape — bail out rather than mangling it.
  return messages
}

/**
 * Counsel  (opencode parity C) — strip the effort knob for models
 * that don't support it (haiku family). Anthropic returns 400 if
 * effort is sent with a haiku model. We strip from BOTH
 * `output_config.effort` (the shape gent emits today via
 * `anthropic/index.ts` `buildAnthropicConfig`) AND `thinking.effort`
 * (the shape the upstream Anthropic SDK may emit in future versions —
 * matches the opencode reference). Each branch deletes the parent
 * object if it empties out.
 *
 *  will replace the `claude-haiku` prefix match with the per-model
 * override table from opencode-claude-auth's `model-config.ts`.
 */
const stripObjectKey = (parent: JsonRecord, key: string): Option.Option<JsonRecord> => {
  if (!(key in parent)) return Option.some(parent)
  const { [key]: _removed, ...rest } = parent
  if (Object.keys(rest).length === 0) return Option.none()
  return Option.some(rest)
}

const stripHaikuEffort = (payload: JsonRecord): JsonRecord => {
  const model = payload["model"]
  if (!Predicate.isString(model)) return payload
  // Counsel  — defer to the per-model override table instead of
  // string-prefix matching here. `disableEffort` is currently set for
  // the `haiku` family in `MODEL_CONFIG`.
  const override = getModelOverride(model)
  if (Option.isNone(override) || override.value.disableEffort !== true) return payload

  const next = { ...payload }
  const outputConfig = next["output_config"]
  if (isRecord(outputConfig)) {
    const stripped = stripObjectKey(outputConfig, "effort")
    Option.match(stripped, {
      onNone: () => delete next["output_config"],
      onSome: (value) => {
        next["output_config"] = value
      },
    })
  }
  const thinking = next["thinking"]
  if (isRecord(thinking)) {
    const stripped = stripObjectKey(thinking, "effort")
    Option.match(stripped, {
      onNone: () => delete next["thinking"],
      onSome: (value) => {
        next["thinking"] = value
      },
    })
  }
  return next
}

/**
 * Apply every outgoing OAuth-billing transform. Order is load-bearing —
 * relocation MUST run BEFORE billing computation because the relocator
 * changes the first-user message text and the billing hash MUST match
 * what's on the wire:
 *
 *   1. transformTools — PascalCase mcp_ prefix on tool names.
 *   2. repairToolPairs — drop orphan tool_use / tool_result blocks
 *      before they can poison the billing hash or trip the API.
 *   3. transformMessages — PascalCase mcp_ prefix on tool_use blocks
 *      in history.
 *   4. transformToolChoice — independent.
 *   5. relocateThirdPartyIntoFirstUser — pull non-billing/non-identity
 *      system blocks into the first user message FIRST, so the
 *      billing hash in step 6 sees the final wire text.
 *   6. buildSystemArray — compute billing from FINAL (post-relocation)
 *      messages; emit the strict `[billing, identity]` system shape.
 *   7. stripHaikuEffort — final payload correction; independent.
 */
export const transformPayload = (
  payload: JsonRecord,
): Effect.Effect<JsonRecord, never, KeychainTransformRequirements> =>
  Effect.gen(function* () {
    let result = { ...payload }

    if (isRecordArray(result["tools"])) {
      result["tools"] = transformTools(result["tools"])
    }

    if (isRecordArray(result["messages"])) {
      result["messages"] = repairToolPairs(result["messages"])
    }

    if (isRecordArray(result["messages"])) {
      result["messages"] = transformMessages(result["messages"])
    }

    if ("tool_choice" in result) {
      result["tool_choice"] = transformToolChoice(result["tool_choice"])
    }

    const { thirdPartyBlocks } = partitionSystemBlocks(result["system"])
    let messagesAfterRelocate: ReadonlyArray<JsonRecord> = []
    if (isRecordArray(result["messages"])) {
      messagesAfterRelocate = relocateThirdPartyIntoFirstUser(thirdPartyBlocks, result["messages"])
    }
    result["messages"] = messagesAfterRelocate
    result["system"] = yield* buildSystemArray(messagesAfterRelocate)

    result = stripHaikuEffort(result)

    return result
  })

// ── Response Transforms (incoming) ──

/** Strip `mcp_` and lowercase the first char so gent sees its
 *  registered tool name (`Bash` from the wire → `bash` internally). */
const stripPrefix = (name: string): string => unprefixName(name)

/** Strip mcp_ prefix from tool_use content blocks in a non-streaming response */
export const transformResponseContent = (
  content: ReadonlyArray<JsonRecord>,
): ReadonlyArray<JsonRecord> =>
  content.map((block) => {
    if (block["type"] === "tool_use" && Predicate.isString(block["name"])) {
      return { ...block, name: stripPrefix(block["name"]) }
    }
    return block
  })

/** Strip mcp_ prefix from streaming content_block_start events.
 *  MessageStreamEvent uses `type` for the event kind, and `content_block` for the block data. */
export const transformStreamEvent = (
  event: AnthropicClient.MessageStreamEvent,
): AnthropicClient.MessageStreamEvent => {
  // content_block_start has type: "content_block_start" and content_block with the block data
  const e = Schema.decodeSync(JsonRecordSchema)(event)
  if (e["type"] !== "content_block_start") return event
  const rawBlock = e["content_block"]
  if (!isRecord(rawBlock)) return event
  const block = rawBlock
  if (block["type"] === "tool_use" && Predicate.isString(block["name"])) {
    return decodeMessageStreamEvent({
      ...event,
      content_block: { ...block, name: stripPrefix(block["name"]) },
    })
  }
  return event
}

// ── Layer ──

type CreateMessageOptions = Parameters<AnthropicClient.Service["createMessage"]>[0]
type CreateMessageStreamOptions = Parameters<AnthropicClient.Service["createMessageStream"]>[0]

/** Wraps an AnthropicClient to apply Claude Code keychain conventions. */
const makeKeychainClientLayer: Layer.Layer<
  AnthropicClient.AnthropicClient,
  never,
  AnthropicClient.AnthropicClient | KeychainTransformRequirements
> = Layer.effect(
  AnthropicClient.AnthropicClient,
  Effect.gen(function* () {
    const inner = yield* AnthropicClient.AnthropicClient
    const transformContext = yield* Effect.context<KeychainTransformRequirements>()
    const transformPayloadHere = (payload: JsonRecord) =>
      transformPayload(payload).pipe(Effect.provideContext(transformContext))

    const service: AnthropicClient.Service = {
      client: inner.client,
      streamRequest: inner.streamRequest,

      createMessage: (options: CreateMessageOptions) =>
        Effect.gen(function* () {
          const payload = yield* Schema.decodeEffect(JsonRecordSchema)(options.payload).pipe(
            Effect.orDie,
          )
          const transformed = yield* transformPayloadHere(payload)
          return yield* inner.createMessage({
            ...options,
            payload: encodeMessagePayload(decodeMessagePayload(transformed)),
          })
        }).pipe(
          Effect.map(([body, response]) => {
            const b = Schema.decodeSync(JsonRecordSchema)(body)
            const content = b["content"]
            if (isRecordArray(content)) {
              const transformed = {
                ...b,
                content: transformResponseContent(content),
              }
              return [
                Schema.decodeUnknownSync(Generated.BetaMessage)(transformed),
                response,
              ] satisfies [typeof body, typeof response]
            }
            return [body, response] satisfies [typeof body, typeof response]
          }),
        ),

      createMessageStream: (options: CreateMessageStreamOptions) =>
        Effect.gen(function* () {
          const payload = yield* Schema.decodeEffect(JsonRecordSchema)(options.payload).pipe(
            Effect.orDie,
          )
          const transformed = yield* transformPayloadHere(payload)
          return yield* inner.createMessageStream({
            ...options,
            payload: encodeMessagePayload(decodeMessagePayload(transformed)),
          })
        }).pipe(
          Effect.map(([response, stream]) => [
            response,
            stream.pipe(Stream.map(transformStreamEvent)),
          ]),
        ),
    }

    return service
  }),
)

// ── keychain transform ──────────────────────────────────────────────────────

/**
 * keychainTransformClient — `@effect/ai-anthropic` `transformClient`
 * callback.
 *
 * The SDK applies `transformClient` after its own baseline header pipeline
 * (`x-api-key`, `anthropic-version`, `accept: application/json`). This
 * middleware augments + overrides what OAuth needs:
 *
 * - Sets `authorization: Bearer <accessToken>` from `AnthropicCredentialService`
 * - Sets `anthropic-beta: <merged>` from per-model defaults
 * - Sets `x-app: cli`, `user-agent: claude-cli/<version> (external, cli)`,
 *   `anthropic-dangerous-direct-browser-access: true`
 * - Removes `x-api-key` (the SDK's baseline injects `oauth-placeholder`
 *   here; Anthropic rejects requests where both `x-api-key` and
 *   `authorization: Bearer` are present)
 *
 * Why `transformClient` over a custom `HttpClient` Layer: the SDK's
 * baseline (`prependUrl`, `anthropic-version`, `acceptJson`) is exactly
 * what we want — replacing it would mean re-implementing it. See
 * `~/.cache/repo/effect-ts/effect-smol/packages/ai/anthropic/src/AnthropicClient.ts:215-232`.
 *
 * Why a factory `(creds) => (client) => client` instead of grabbing the
 * service from context inside `mapRequestEffect`: the SDK's
 * `transformClient` signature is `(HttpClient) => HttpClient`, which
 * requires the returned client's requirement channel to be empty.
 * `mapRequestEffect` widens that channel to whatever services its body
 * yields — so reading the service from context per-request would
 * surface `AnthropicCredentialService` as a requirement and not
 * type-check against the SDK signature. The factory captures the
 * service instance in a closure; per-request semantics are preserved
 * because each call to `creds.getFresh` still consults the live
 * `Ref` cache.
 *
 * This file ships the full middleware stack: auth headers (2a),
 * 429/529 + transport retry (2b), long-context beta retry (2d), and
 * 401 recovery (2e). Layered outside-in via `pipe`, the order is:
 *   - mapRequestEffect (preprocess) — auth + cache-aware headers
 *   - long-context beta retry (innermost transformResponse)
 *   - 429/529 + transport retry (middle)
 *   - 401 recovery (outermost) — invalidate creds + retry once
 *
 * On the long-context beta retry: the Anthropic API rejects requests
 * that include both `context-1m-2025-08-07` and `interleaved-thinking-
 * 2025-05-14` for some accounts/models with a 400 + a body string
 * containing "Extra usage is required for long context requests" or
 * "long context beta is not yet available". The fix is to retry with
 * one of those betas removed, learning across requests so the next
 * turn doesn't re-include it. The cross-request learning state lives
 * in `AnthropicBetaCache` (Commit 2c); this middleware reads from it
 * in `mapRequestEffect` (so the outgoing header reflects what we've
 * learned) and writes to it in the beta-retry `transformResponse` (so
 * the next attempt's preprocess sees the updated set).
 *
 * On retry: covers two failure classes with one budget (2 retries / 3
 * attempts at 1s exponential):
 *   1. 429/529 responses — Anthropic rate-limit + Overloaded.
 *      `HttpClient.retryTransient` covers 408/429/500/502/503/504 but
 *      NOT 529, so we re-raise both as a typed `TransientResponseError`
 *      via `HttpClient.transformResponse` and let `Effect.retry` see it.
 *   2. Transport failures (`HttpClientError` from the wire) — retried under
 *      the same budget as transient HTTP responses.
 * The catch-tag at the end folds the terminal 429/529 back into the
 * success channel; transport failures that exhaust the budget propagate
 * as `HttpClientError` (the SDK's expected error type).
 */

// ── Typed errors ──

/**
 * Internal error used to drive 429/529 retry through `Effect.retry`.
 * Carries the response so the catch-tag can hand the final 429/529
 * back to the caller after the retry budget is exhausted (instead of
 * surfacing as an unrelated typed failure).
 *
 * `response` is declared as `Schema.Any` because `HttpClientResponse`
 * is a class-shaped type from a vendor module and embedding its full
 * Schema would force this module to depend on undocumented internals.
 * The typed accessor `getResponse` re-narrows for the catch-tag.
 */
class TransientResponseError extends Schema.TaggedError<TransientResponseError>(
  "@gent/extensions/src/anthropic/TransientResponseError",
)("TransientResponseError", {
  response: Schema.Any,
}) {
  getResponse(): HttpClientResponse.HttpClientResponse {
    return this.response
  }
}

const isTransientStatus = (status: number): boolean => status === 429 || status === 529

/**
 * Internal error driving the long-context beta retry. Same Schema.Any
 * accessor pattern as `TransientResponseError` for the same vendor-class
 * Schema reason.
 */
class LongContextBetaError extends Schema.TaggedError<LongContextBetaError>(
  "@gent/extensions/src/anthropic/LongContextBetaError",
)("LongContextBetaError", {
  response: Schema.Any,
}) {
  getResponse(): HttpClientResponse.HttpClientResponse {
    return this.response
  }
}

/**
 * Pick the next long-context beta to drop given the candidates the
 * model actually emits and the set already excluded.
 */
const pickNextBetaToExclude = (
  modelId: string,
  currentBetaFlags: Option.Option<string>,
  excluded: ReadonlySet<string>,
): Option.Option<string> => {
  for (const beta of getLongContextBetasForWith(modelId, currentBetaFlags)) {
    if (!excluded.has(beta)) return Option.some(beta)
  }
  return Option.none()
}

// ── Helpers ──

/**
 * Decode the request body to a string for model-id extraction. The
 * Anthropic SDK serializes JSON bodies as Uint8Array; some caller surfaces use
 * Raw strings. Anything else (FormData / Stream / Empty) returns None and
 * the parser short-circuits to "unknown".
 */
const decodeString = Schema.decodeUnknownOption(Schema.String)

const requestBodyText = (req: HttpClientRequest.HttpClientRequest): Option.Option<string> => {
  if (req.body._tag === "Uint8Array") {
    return Option.some(new TextDecoder().decode(req.body.body))
  }
  if (req.body._tag === "Raw") {
    return decodeString(req.body.body)
  }
  return Option.none()
}

/**
 * Build the OAuth header set for a request. `excluded` is an optional
 * set of betas to drop (used by the beta-retry middleware in commit
 * 2d; for 2a it's always empty / undefined).
 */
const buildOauthHeaders = (
  req: HttpClientRequest.HttpClientRequest,
  accessToken: string,
  modelId: string,
  env: AnthropicKeychainEnv,
  excluded?: Set<string>,
): Headers.Headers => {
  // Start from the SDK's existing headers (preserve `anthropic-version`
  // etc.) but drop `x-api-key` since OAuth uses Bearer.
  let headers = Headers.remove(req.headers, "x-api-key")

  const modelBetas = getModelBetas(
    modelId,
    Option.fromNullishOr(env.betaFlags),
    Option.fromNullishOr(excluded),
  )
  const incomingBeta = headers["anthropic-beta"] ?? ""
  const mergedBetas = Array.from(
    new Set([
      ...modelBetas,
      ...incomingBeta
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  )

  headers = Headers.set(headers, "authorization", `Bearer ${accessToken}`)
  headers = Headers.set(headers, "anthropic-beta", mergedBetas.join(","))
  headers = Headers.set(headers, "x-app", "cli")
  headers = Headers.set(headers, "user-agent", getUserAgent(env))
  // The billing header lives in `system[0]` (see keychain-client.ts +
  // signing.ts), NOT as an HTTP header. We do set this declarative
  // browser-access acknowledgement to match Claude Code's behavior.
  headers = Headers.set(headers, "anthropic-dangerous-direct-browser-access", "true")

  return headers
}

// ── transformClient factory ──

/**
 * Build the `transformClient` value the Anthropic SDK accepts.
 *
 * Takes the `AnthropicCredentialService` instance as a closure
 * argument (not via `yield*` inside `mapRequestEffect`) because the
 * SDK's `transformClient` signature `(HttpClient) => HttpClient`
 * requires the returned client to have an empty requirement channel —
 * yielding the service from context inside the middleware would
 * surface it as a requirement and break the type.
 *
 * Per-request semantics are preserved: each request invokes
 * `creds.getFresh` which consults the live `Ref` cache. The closure
 * captures the dispatcher (the service instance), not a snapshot of
 * its state.
 */
export const buildKeychainTransformClient =
  (
    creds: CredentialCache<ClaudeCredentials>,
    betaCache: AnthropicBetaCacheApi,
    env: AnthropicKeychainEnv,
  ): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  (client) =>
    client.pipe(
      HttpClient.mapRequestEffect((req) =>
        Effect.gen(function* () {
          const fresh = yield* freshCredentials(creds, req)
          const modelId = parseModelIdFromBody(requestBodyText(req))
          const betaFlags = env.betaFlags
          // Read the cross-request-learned exclusion set from the
          // betaCache. On retry, mapRequestEffect re-runs and reads the
          // updated set — the beta-retry transformResponse below records
          // the rejected beta into the cache before failing to retry.
          const excluded = yield* betaCache.getExcluded(modelId, Option.fromNullishOr(betaFlags))
          const headers = buildOauthHeaders(req, fresh.accessToken, modelId, env, new Set(excluded))
          return withHeaders(req, headers)
        }),
      ),
      // Long-context beta retry: on 400 with the long-context marker in
      // the body, record the offending beta into the cache and fail with
      // LongContextBetaError so Effect.retry re-runs preprocess (which
      // re-reads the now-larger excluded set) + postprocess. Budget = one
      // retry slot per long-context candidate the model actually emits
      // (Counsel  deep at the to-be-deleted oauth.ts:847-887 fixed
      // the prior off-by-one + per-model-override bugs; this port
      // preserves that fix). When candidates exhaust, the catch-tag
      // folds the terminal 400 back into the success channel.
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.flatMap(
            (
              response,
            ): Effect.Effect<
              HttpClientResponse.HttpClientResponse,
              LongContextBetaError | HttpClientError
            > => {
              switch (response.status) {
                case 400:
                  return response.text.pipe(
                    Effect.flatMap((body) => {
                      if (!isLongContextError(body)) return Effect.succeed(response)
                      // Body matches: try to record the next beta + retry.
                      const modelId = parseModelIdFromBody(requestBodyText(response.request))
                      const betaFlags = env.betaFlags
                      return betaCache.getExcluded(modelId, Option.fromNullishOr(betaFlags)).pipe(
                        Effect.flatMap((excluded) => {
                          const beta = pickNextBetaToExclude(
                            modelId,
                            Option.fromNullishOr(betaFlags),
                            excluded,
                          )
                          if (Option.isNone(beta)) return Effect.succeed(response)
                          return betaCache
                            .recordExcluded(modelId, beta.value, Option.fromNullishOr(betaFlags))
                            .pipe(
                              Effect.flatMap(() =>
                                Effect.fail(new LongContextBetaError({ response })),
                              ),
                            )
                        }),
                      )
                    }),
                  )
                default:
                  return Effect.succeed(response)
              }
            },
          ),
          // Budget: at most one retry per long-context beta — bounded
          // because every retry adds one beta to the cache's excluded
          // set, and `pickNextBetaToExclude` returns `None` once
          // exhausted (which short-circuits to success above without
          // re-failing). The numeric `times` is a belt-and-suspenders
          // bound; the real terminator is the `null` short-circuit.
          Effect.retry({
            while: (e) => e._tag === "LongContextBetaError",
            times: 8,
          }),
          Effect.catchTag("LongContextBetaError", (e) => Effect.succeed(e.getResponse())),
        ),
      ),
      // Retry: 2 retries (3 attempts total) with exponential backoff
      // starting at 1s. Retries both:
      //   - 429/529 responses (Anthropic rate-limit + Overloaded)
      //   - Transport failures (HttpClientError from the wire).
      // `transformResponse` re-raises 429/529 as a typed failure so
      // `Effect.retry` can react. The catch-tag at the end folds the
      // terminal 429/529 back into the success channel after the budget
      // is exhausted, keeping the public HttpClient contract intact.
      // Genuine transport errors that exhaust the budget propagate as
      // `HttpClientError` — the SDK's expected error type.
      HttpClient.transformResponse((effect) =>
        effect.pipe(
          Effect.flatMap(
            (
              response,
            ): Effect.Effect<HttpClientResponse.HttpClientResponse, TransientResponseError> => {
              switch (isTransientStatus(response.status)) {
                case true:
                  return Effect.fail(new TransientResponseError({ response }))
                default:
                  return Effect.succeed(response)
              }
            },
          ),
          Effect.retry({
            schedule: Schedule.exponential("1 second"),
            times: 2,
          }),
          Effect.catchTag("TransientResponseError", (e) => Effect.succeed(e.getResponse())),
        ),
      ),
      recoverUnauthorized(creds),
    )

// ── extension ───────────────────────────────────────────────────────────────

// Credential cache + refresh logic live in `AnthropicCredentialService`
// (Effect-native). The OAuth path provides this service into the layer
// that hosts `AnthropicClient`; the keychain transform middleware reads
// from it per-request via `mapRequestEffect`.

// Maps gent reasoning level to Anthropic effort.
//
// The Anthropic API accepts `max` (and Sonnet 5 also accepts `xhigh`), but the
// installed `@effect/ai-anthropic` config type is narrower than the wire
// schema: `AnthropicLanguageModel.layer`'s `output_config.effort` is
// `"low" | "medium" | "high"`, while `Generated.ts` `EffortLevel` is
// `"low" | "medium" | "high" | "max"`. Passing `max` here fails typecheck
// (TS2322). So `xhigh` and `max` clamp to `high` until that config type widens.
// Verified against @effect/ai-anthropic@4.0.0-rc.112 on 2026-09-09.
const ANTHROPIC_EFFORT = new Map<string, "low" | "medium" | "high">([
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "high"],
  ["max", "high"],
])

type AnthropicConfig = Required<Parameters<typeof AnthropicLanguageModel.layer>[0]>["config"]

const buildAnthropicConfig = (hints: Option.Option<ProviderHints>): AnthropicConfig => {
  let config: AnthropicConfig = {}
  if (Option.isSome(hints)) {
    const maxTokens = Option.fromNullishOr(hints.value.maxTokens)
    if (Option.isSome(maxTokens)) config = { ...config, max_tokens: maxTokens.value }
    const temperature = Option.fromNullishOr(hints.value.temperature)
    if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
    const reasoning = Option.fromNullishOr(hints.value.reasoning)
    if (Option.isSome(reasoning) && reasoning.value !== "none") {
      const effort = Option.fromNullishOr(ANTHROPIC_EFFORT.get(reasoning.value))
      if (Option.isSome(effort)) config = { ...config, output_config: { effort: effort.value } }
    }
  }
  return config
}

// ── Layer construction helpers ──

/**
 * API-key path: plain `AnthropicClient.layer` over `FetchHttpClient`.
 * No keychain wrapper — `keychainClient` injects Claude Code OAuth
 * billing-header system blocks + identity prefix, which API-key users
 * are not on the hook for.
 */
const makeApiKeyAnthropicLayer = (modelName: string, config: AnthropicConfig, apiKey: string) => {
  const clientLayer = AnthropicClient.layer({
    apiKey: Redacted.make(apiKey),
  }).pipe(Layer.provide(FetchHttpClient.layer))
  return AnthropicLanguageModel.layer({ model: modelName, config }).pipe(Layer.provide(clientLayer))
}

/**
 * OAuth path: builds `AnthropicClient.layer` with `transformClient` set
 * to the keychain transform middleware (auth headers, 429/529 retry,
 * transport retry, long-context beta retry, 401 recovery). Uses
 * `Layer.unwrap` because the transform factory needs the credential
 * service and beta cache instances at construction time, and those
 * come from layers that the unwrapped Effect can `yield*`.
 *
 * The cache cells for credentials and beta state are passed in from
 * extension-closure scope (allocated once by the Effectful
 * `modelDrivers()` setup), not per layer build. Without this hoist,
 * every `Provider.stream`/`Provider.generate` call rebuilds the service
 * layer and resets the cache, killing cross-request beta learning and
 * credential reuse.
 *
 * No `apiKey` is passed — the SDK's apiKey is optional and skips
 * `x-api-key` injection when absent (verified at
 * `~/.cache/repo/effect-ts/effect-smol/packages/ai/anthropic/src/AnthropicClient.ts:220`).
 * Avoids a brittle "scrub-the-placeholder" coupling between SDK and
 * middleware ordering.
 */
const makeOauthAnthropicLayer = (
  modelName: string,
  config: AnthropicConfig,
  authInfo: ProviderAuthInfo,
  credentialCellRef: CredentialCacheCellRef<ClaudeCredentials>,
  betaCellRef: Ref.Ref<BetaCacheCell>,
  platform: AnthropicPlatformApi,
) => {
  const credentialLayer = AnthropicCredentialService.layerFromRef(credentialCellRef, authInfo)
  const cacheLayer = AnthropicBetaCache.layerFromRef(betaCellRef)

  const clientLayer = Layer.unwrap(
    Effect.gen(function* () {
      const creds = yield* AnthropicCredentialService
      const cache = yield* AnthropicBetaCache
      return AnthropicClient.layer({
        transformClient: buildKeychainTransformClient(creds, cache, platform.env),
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  ).pipe(Layer.provide(credentialLayer), Layer.provide(cacheLayer))

  const wrappedClient = makeKeychainClientLayer.pipe(
    Layer.provide(clientLayer),
    Layer.provide(BunGentPlatformLive),
    Layer.provide(Layer.succeed(AnthropicPlatform, platform)),
  )
  return AnthropicLanguageModel.layer({ model: modelName, config }).pipe(
    Layer.provide(wrappedClient),
    Layer.provide(BunServices.layer),
  )
}

/**
 * Build the model-driver contribution given pre-allocated cache cell
 * cells. Extracted from the inline `modelDrivers` factory so tests can
 * inject their own cells and assert that two `resolveModel` calls share
 * the same closure-owned cells (fresh Refs per `resolveModel` would
 * kill cross-request beta learning).
 */
export const buildAnthropicModelDriver = (
  credentialCellRef: CredentialCacheCellRef<ClaudeCredentials>,
  betaCellRef: Ref.Ref<BetaCacheCell>,
  envApiKey: Option.Option<string>,
  platform: AnthropicPlatformApi,
): ModelDriverContribution => ({
  id: "anthropic",
  name: "Anthropic",
  retry: {
    ...DEFAULT_RETRY_POLICY,
    // An accepted request can still end with an error event inside the stream; Anthropic names its type.
    transientStreamEvent: Schema.Struct({
      type: Schema.Literals(["overloaded_error", "api_error", "rate_limit_error"]),
    }),
  },
  resolveModel: (modelName, authInfo, hints) =>
    Effect.gen(function* () {
      const auth = Option.fromNullishOr(authInfo)
      // Precedence: stored API key > env API key > keychain/OAuth
      let apiKey = envApiKey
      if (Option.isSome(auth) && auth.value.type === "api") {
        apiKey = Option.fromNullishOr(auth.value.key)
      }

      const config = buildAnthropicConfig(Option.fromNullishOr(hints))

      if (Option.isSome(apiKey)) {
        return AiModel.make(
          "anthropic",
          modelName,
          makeApiKeyAnthropicLayer(modelName, config, apiKey.value),
        )
      }

      // Fail closed — no stored API key, no env var, and no stored OAuth.
      // (The OAuth layer builds over `authInfo` — with `authInfo` absent
      // it builds an unauthenticated client that fails late as a generic
      // HTTP error, masking the real auth failure for non-TUI callers.
      // Keychain fallback is handled by the extension's `authorize` flow
      // upstream; by the time we reach `resolveModel`, any valid creds
      // have already been staged into `authInfo`.)
      if (Option.isNone(auth) || auth.value.type !== "oauth") {
        return yield* new ProviderAuthError({
          message:
            "Anthropic credentials unavailable: no Claude Code OAuth, stored API key, or ANTHROPIC_API_KEY env var",
        })
      }

      // OAuth path: per-resolveModel layer build wires the
      // extension-closure-owned cache cells into a fresh credential
      // service + beta cache layer pair. The Refs are shared across all
      // calls, so cross-request beta learning and credential cache reuse
      // survive.
      return AiModel.make(
        "anthropic",
        modelName,
        makeOauthAnthropicLayer(
          modelName,
          config,
          auth.value,
          credentialCellRef,
          betaCellRef,
          platform,
        ),
      )
    }),
  auth: {
    methods: [
      AuthMethod.make({ type: "oauth", label: "Claude Code" }),
      AuthMethod.make({ type: "api", label: "Manually enter API key" }),
    ],
    authorize: (ctx) =>
      Effect.gen(function* () {
        if (ctx.methodIndex !== 0) return Option.none()
        // The Claude Code authorize flow targets the primary
        // account by default. PRIMARY_CLAUDE_SERVICE is spelled
        // out here so a future audit-grep finds every "default"
        // site (the multi-account picker UI is the next consumer).
        let creds = yield* readClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE)
        const now = yield* Clock.currentTimeMillis
        if (!freshEnoughForUse(creds, now)) {
          // Use the returned creds — re-reading keychain after refresh
          // would silently lose direct-OAuth tokens whenever write-back
          // failed.
          creds = yield* refreshClaudeCodeCredentials(PRIMARY_CLAUDE_SERVICE)
        }
        // Persist keychain creds to Auth
        yield* ctx.persist({
          type: "oauth",
          access: creds.accessToken,
          refresh: creds.refreshToken,
          expires: creds.expiresAt,
        })
        return Option.some({
          url: "",
          method: "done",
        } satisfies ProviderAuthorizationResult)
      }).pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(
            new ProviderAuthError({
              message: `Anthropic authorization failed: ${Option.match(
                Schema.decodeUnknownOption(Schema.instanceOf(Error))(cause),
                { onNone: () => String(cause), onSome: (error) => error.message },
              )}`,
              cause,
            }),
          ),
        ),
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(Layer.merge(BunServices.layer, Layer.succeed(AnthropicPlatform, platform))),
      ),
  },
})

export const AnthropicExtension = defineExtension({
  id: "@gent/provider-anthropic",
  setup: Effect.gen(function* () {
    const ctx = yield* ExtensionHost
    const env: AnthropicKeychainEnv = makeAnthropicKeychainEnv({
      betaFlags: yield* readOptionalEnv("ANTHROPIC_BETA_FLAGS"),
      cliVersion: yield* readOptionalEnv("ANTHROPIC_CLI_VERSION"),
      entrypoint: yield* readOptionalEnv("CLAUDE_CODE_ENTRYPOINT"),
      userAgent: yield* readOptionalEnv("ANTHROPIC_USER_AGENT"),
    })

    const envApiKey = yield* readOptionalEnv("ANTHROPIC_API_KEY")
    const platform = AnthropicPlatform.fromSetup(ctx, env)

    // Cache cells are hoisted to extension-closure scope so they
    // survive across `resolveModel` calls. Lifetime: one extension
    // instance → one cell that lives until the runtime tears the
    // extension down. Setup is Effectful, so cache cells are allocated
    // through SynchronizedRef.make instead of an unsafe closure escape hatch.
    const credentialCellRef =
      yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
    const betaCellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)

    yield* ctx.register(
      "modelDriver",
      buildAnthropicModelDriver(credentialCellRef, betaCellRef, envApiKey, platform),
    )
  }),
})
