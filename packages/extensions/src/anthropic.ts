import {
  Cause,
  Clock,
  Context,
  Crypto,
  Duration,
  Effect,
  Encoding,
  Equal,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Redacted,
  Ref,
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
  runProcess,
} from "@gent/core/extensions/api"
import {
  type CatalogSource,
  catalogSource,
  type CredentialCache,
  type CredentialCacheCell,
  type CredentialCacheCellRef,
  type CredentialFailure,
  checkCredentials,
  CredentialRefreshUnavailable,
  driverListModels,
  EMPTY_CREDENTIAL_CELL,
  explainCredentialFailure,
  freshCredentials,
  freshEnoughAt,
  isTransientTokenStatus,
  makeCredentialCache,
  postOAuthForm,
  readOptionalEnv,
  recoverUnauthorized,
  withHeaders,
} from "./providers.js"
import type { ChildProcessSpawner } from "effect/unstable/process"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  type HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel, Generated } from "@effect/ai-anthropic"
import type { HttpClientError } from "effect/unstable/http/HttpClientError"
import { BunCrypto, BunServices } from "@effect/platform-bun"
import { Model as AiModel } from "effect/unstable/ai"

// ── model config ────────────────────────────────────────────────────────────

/**
 * Per-model Anthropic configuration — beta flags, ccVersion, and
 * model-specific overrides, in one place. Follows
 * `griffinmartin/opencode-claude-auth/src/model-config.ts`.
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

/**
 * Env vars for Anthropic keychain, read once at extension setup and
 * carried alongside platform inputs, so each extension instance carries
 * its own snapshot.
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
    ctx: Pick<ExtensionHostService, "host">,
    env: AnthropicKeychainEnv,
  ): AnthropicPlatformApi =>
    AnthropicPlatform.of({
      platform: ctx.host.osInfo.platform,
      home: ctx.host.homeDirectory,
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
 * Hex SHA-256 of `text` (UTF-8). A digest of an in-memory buffer does not
 * fail on a working runtime, so a failure is a defect.
 */
const sha256Hex = (text: string): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(text))
      .pipe(Effect.orDie)
    return Encoding.encodeHex(digest)
  })

/**
 * Compute `cch` — first 5 hex chars of `sha256(messageText)`. The
 * Anthropic billing-validation step rejects requests whose `cch`
 * doesn't match the first user message we send, so this MUST be
 * recomputed per request.
 */
export const computeCch = (messageText: string): Effect.Effect<string, never, Crypto.Crypto> =>
  sha256Hex(messageText).pipe(Effect.map((hex) => hex.slice(0, 5)))

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
): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const sampled = [4, 7, 20]
      .map((index) => Option.getOrElse(Option.fromNullishOr(messageText[index]), () => "0"))
      .join("")
    const hex = yield* sha256Hex(`${BILLING_SALT}${sampled}${version}`)
    return hex.slice(0, 3)
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
): Effect.Effect<string, never, Crypto.Crypto> =>
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
 * server hates. It is a service, so it composes through Layer and
 * holds no import-time mutable state.
 *
 * Two implicit clear conditions:
 *   1. `betaFlags` env changes — user toggled flags, prior learning
 *      may no longer apply.
 *   2. `modelId` changes — different model, different beta surface.
 *
 * `getExcluded` takes `currentBetaFlags` as a parameter (not yielded
 * from a hidden module). Production wiring passes the env beta flags;
 * tests can pass anything they want. No global mutation.
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
  // Env betaFlags changed → clear everything.
  if (!Equal.equals(cell.lastBetaFlags, currentBetaFlags)) {
    return { map: new Map(), lastBetaFlags: currentBetaFlags, lastModelId: Option.some(modelId) }
  }
  // Model changed → clear. The first request has nothing to clear.
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
   * The cell Ref is provided externally so the cache lives for the
   * extension lifetime, not one `resolveModel` call. A beta the server
   * rejected on turn N stays excluded on turn N+1.
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
 * Long-context backoff candidates: only the long-context betas that
 * appear in this model's outgoing header, after per-model overrides.
 * A beta the model never sends is never a backoff candidate, and the
 * call site gives each candidate its own retry slot.
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
 * `buildBillingHeaderValue` builds the header text per request because
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
    // chmod 0600 after write so the credentials file is not
    // world-readable on first creation.
    yield* fs.chmod(credentialsFile, 0o600).pipe(Effect.mapError(mapFsError))
  })

// ── oauth keychain ──────────────────────────────────────────────────────────

/** The keychain service Claude Code stores its primary account under. */
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"

class ClaudeKeychainNotFoundError extends Schema.TaggedError<ClaudeKeychainNotFoundError>()(
  "ClaudeKeychainNotFoundError",
  {},
) {}

const spawnSecurity = (
  args: readonly string[],
): Effect.Effect<
  string,
  ProviderAuthError | ClaudeKeychainNotFoundError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const result = yield* runProcess("security", args, { timeout: Duration.millis(5000) }).pipe(
      Effect.catchTag("ProcessError", (e) => {
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

const readFromKeychain: Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError | ClaudeKeychainNotFoundError,
  ChildProcessSpawner.ChildProcessSpawner
> = spawnSecurity(["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"]).pipe(
  Effect.flatMap(decodeCredentials),
)

/**
 * Discover the macOS username stored on a keychain entry. The Claude
 * CLI uses the user's account name (e.g. "alice") as the keychain
 * `acct` field, NOT the service name. Writing with the wrong `acct`
 * creates a duplicate entry instead of updating the existing one —
 * exactly the bug `griffinmartin/opencode-claude-auth` ran into.
 */
const getKeychainAccountName = (
  serviceName: string,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runProcess("security", ["find-generic-password", "-s", serviceName], {
    timeout: Duration.millis(2000),
  }).pipe(
    Effect.map((result) => {
      const match = /"acct"<blob>="([^"]*)"/.exec(result.stdout)
      return Option.fromNullishOr(match?.[1])
    }),
    Effect.catchEager(() => Effect.succeedNone),
  )

const writeKeychainEntry = (
  serviceName: string,
  accountName: string,
  payload: string,
): Effect.Effect<void, ProviderAuthError, ChildProcessSpawner.ChildProcessSpawner> =>
  runProcess(
    "security",
    ["add-generic-password", "-s", serviceName, "-a", accountName, "-w", payload, "-U"],
    { timeout: Duration.millis(2000), stdout: "ignore" },
  ).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.void
      return Effect.fail(
        new ProviderAuthError({
          message: `Failed to write Claude credentials to Keychain: ${result.stderr.trim() || `security add-generic-password exit ${result.exitCode}`}`,
        }),
      )
    }),
    Effect.catchTag("ProcessError", (e) =>
      Effect.fail(
        new ProviderAuthError({
          message: `Failed to write Claude credentials to Keychain: ${e.message}`,
          cause: e,
        }),
      ),
    ),
  )

// ── oauth accounts ──────────────────────────────────────────────────────────

/**
 * Read Claude Code's primary-account credentials: the keychain on darwin,
 * falling back to `~/.claude/.credentials.json` when the keychain has no
 * entry; that file alone elsewhere, mirroring the CLI.
 */
const readClaudeCodeCredentials: Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const platform = yield* AnthropicPlatform
  if (platform.platform !== "darwin") {
    return yield* readCredentialsFile
  }
  return yield* readFromKeychain.pipe(
    Effect.catchIf(Schema.is(ClaudeKeychainNotFoundError), () => readCredentialsFile),
  )
})

/**
 * Persist refreshed credentials back to the primary keychain entry
 * (or `~/.claude/.credentials.json` on non-darwin). Without
 * this, every direct OAuth refresh is wasted — the next read pulls
 * the stale `accessToken` straight back from disk/keychain. The
 * `acct` field is preserved by reading the existing entry first.
 *
 * Errors are surfaced as `ProviderAuthError` for the caller to log:
 * write-back is best-effort; the in-memory creds are authoritative for
 * the in-flight request.
 */
const writeBackCredentials = (
  creds: ClaudeCredentials,
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

    // A read failure surfaces as a typed error, so the refresh call site
    // warns instead of reporting a keychain fault as a successful update.
    //
    // ClaudeKeychainNotFoundError is mapped to a ProviderAuthError so
    // the public signature stays narrow — write-back callers use a
    // best-effort `catchEager` that doesn't need to know about the
    // internal not-found tag.
    const raw = yield* spawnSecurity([
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-w",
    ]).pipe(
      Effect.catchIf(Schema.is(ClaudeKeychainNotFoundError), () =>
        Effect.fail(
          new ProviderAuthError({
            message: `Cannot write back: no keychain entry for ${CLAUDE_KEYCHAIN_SERVICE}`,
          }),
        ),
      ),
    )
    const updated = updateCredentialBlob(raw, creds)
    if (Option.isNone(updated)) return
    const accountName = Option.getOrElse(
      yield* getKeychainAccountName(CLAUDE_KEYCHAIN_SERVICE),
      () => CLAUDE_KEYCHAIN_SERVICE,
    )
    yield* writeKeychainEntry(CLAUDE_KEYCHAIN_SERVICE, accountName, updated.value)
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
 * A transport failure, a timeout, a 429, or a 5xx is
 * `CredentialRefreshUnavailable` (it can pass); any other failure is a
 * `ProviderAuthError`. The caller falls back to `claude -p . --model haiku`
 * (which triggers the CLI's own refresh logic) when the direct refresh fails.
 */
const refreshViaOAuth = (
  refreshToken: string,
): Effect.Effect<ClaudeCredentials, CredentialFailure> =>
  Effect.gen(function* () {
    const response = yield* postOAuthForm(OAUTH_TOKEN_URL, {
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }).pipe(
      Effect.mapError(
        (e) =>
          new CredentialRefreshUnavailable({
            message: `Direct OAuth refresh failed: ${e.message}`,
            cause: e,
          }),
      ),
    )
    if (isTransientTokenStatus(response.status)) {
      return yield* new CredentialRefreshUnavailable({
        message: `Direct OAuth refresh failed: ${response.status} ${response.body}`,
      })
    }
    if (response.status >= 400) {
      return yield* new ProviderAuthError({
        message: `Direct OAuth refresh failed: ${response.status} ${response.body}`,
      })
    }
    const now = yield* Clock.currentTimeMillis
    const creds = parseOAuthResponse(response.body, refreshToken, now)
    if (Option.isNone(creds)) {
      return yield* new ProviderAuthError({
        message: "OAuth refresh response missing access_token",
      })
    }
    return creds.value
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(FetchHttpClient.layer),
  )

/**
 * Run `claude -p .` so the CLI refreshes its own credentials. stdin is
 * closed so the CLI does not wait for piped input. It runs in the home
 * directory, not the server's, so it does not load the hooks, `CLAUDE.md`,
 * or MCP config of whatever project started the shared server, and does
 * not write a transcript there.
 */
const spawnClaudeCli = (
  home: string,
): Effect.Effect<void, ProviderAuthError, ChildProcessSpawner.ChildProcessSpawner> =>
  runProcess("claude", ["-p", ".", "--model", "haiku"], {
    cwd: home,
    stdin: "ignore",
    env: { TERM: "dumb" },
    extendEnv: true,
    timeout: Duration.millis(60_000),
    stdout: "ignore",
    stderr: "ignore",
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.void
      return Effect.fail(
        new ProviderAuthError({
          message: `Failed to refresh Claude Code credentials via CLI: claude CLI exited with code ${result.exitCode}`,
        }),
      )
    }),
    Effect.catchTag("ProcessError", (e) =>
      Effect.fail(
        new ProviderAuthError({
          message: `Failed to refresh Claude Code credentials via CLI: ${e.message}`,
          cause: e,
        }),
      ),
    ),
  )

/**
 * Refresh the Claude Code credentials and return the fresh ones directly
 * to the caller. The direct OAuth endpoint (fast, free) is tried first with
 * the keychain's refresh token, which the `claude` CLI may have rotated,
 * then with the held token when it differs. Only when both fail does it
 * spawn `claude` (slow, costs Haiku tokens) and re-read the keychain.
 *
 * Crucially the caller MUST use the returned value rather than
 * re-reading keychain after the call. A void-returning shape would
 * silently lose direct-OAuth tokens whenever write-back failed
 * (locked keychain, file perms, race with `claude` CLI). Write-back
 * here is best-effort; the in-memory creds are authoritative for this
 * turn.
 *
 * The failure is `CredentialRefreshUnavailable` when the token endpoint
 * was unreachable and the CLI fallback also failed, so the loop retries.
 */
const refreshClaudeCodeCredentials = (
  held: Option.Option<ClaudeCredentials>,
): Effect.Effect<
  ClaudeCredentials,
  CredentialFailure,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    // Why each direct attempt failed. A failed CLI fallback reports all of
    // them instead of only the last one.
    const failures: Array<string> = []
    let endpointUnavailable = false
    const current = yield* Effect.exit(readClaudeCodeCredentials)
    if (Exit.isFailure(current)) {
      failures.push(
        Option.match(Cause.findErrorOption(current.cause), {
          onNone: () => "keychain read failed",
          onSome: (error) => error.message,
        }),
      )
    }
    let keychainToken = ""
    if (Exit.isSuccess(current)) keychainToken = current.value.refreshToken
    const heldToken = Option.match(held, { onNone: () => "", onSome: (c) => c.refreshToken })
    const tokens = [keychainToken, heldToken].filter(
      (token, index, all) => token !== "" && all.indexOf(token) === index,
    )
    if (tokens.length === 0) failures.push("no stored refresh token")
    for (const token of tokens) {
      const refreshed = yield* Effect.exit(refreshViaOAuth(token))
      if (Exit.isSuccess(refreshed)) {
        // Best-effort write-back so subsequent processes pick up the
        // new token. A failure here doesn't lose the refresh — the
        // caller has it in memory.
        yield* writeBackCredentials(refreshed.value).pipe(
          Effect.catchEager((e: ProviderAuthError) =>
            Effect.logWarning("anthropic.oauth.writeback.failed").pipe(
              Effect.annotateLogs({ error: String(e) }),
            ),
          ),
        )
        return refreshed.value
      }
      const error = Cause.findErrorOption(refreshed.cause)
      failures.push(
        Option.match(error, {
          onNone: () => "direct OAuth refresh failed",
          onSome: (e) => e.message,
        }),
      )
      // An unreachable endpoint rejects every token alike; stop here.
      if (Option.isSome(error) && error.value._tag === "CredentialRefreshUnavailable") {
        endpointUnavailable = true
        break
      }
    }
    // Direct path failed — fall back to the CLI spawn (second attempt
    // historically helps when the first invocation kicks a stale-token
    // error). The CLI refreshes its active account, which is the
    // primary one read here.
    const platform = yield* AnthropicPlatform
    return yield* spawnClaudeCli(platform.home).pipe(
      Effect.retry({ times: 1 }),
      Effect.andThen(readClaudeCodeCredentials),
      Effect.mapError((cause): CredentialFailure => {
        const message = `${failures.join("; ")}; CLI fallback: ${cause.message}`
        if (endpointUnavailable) return new CredentialRefreshUnavailable({ message, cause })
        return new ProviderAuthError({ message, cause })
      }),
    )
  })

// ── credential service ──────────────────────────────────────────────────────

/**
 * AnthropicCredentialService — Claude Code credentials behind the shared
 * credential cache (`makeCredentialCache` in `providers.ts`).
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
  /** Read the primary account's stored creds. */
  readonly read: CredentialIO
  /** Refresh the primary account's creds via OAuth or CLI fallback; `held` is the cached credential. */
  readonly refresh: (
    held: Option.Option<ClaudeCredentials>,
  ) => Effect.Effect<ClaudeCredentials, CredentialFailure, AnthropicCredentialIORequirements>
}

const realIO: AnthropicCredentialIO = {
  read: readClaudeCodeCredentials,
  refresh: refreshClaudeCodeCredentials,
}

// ── Service tag ──

export class AnthropicCredentialService extends Context.Service<
  AnthropicCredentialService,
  CredentialCache<ClaudeCredentials>
>()("@gent/extensions/src/anthropic/AnthropicCredentialService") {
  /** Test-friendly variant — accepts the IO seam so tests can drive read/refresh deterministically. */
  static layerFromIO = (io: AnthropicCredentialIO, authInfo?: ProviderAuthInfo) =>
    Layer.effect(
      AnthropicCredentialService,
      SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL).pipe(
        Effect.flatMap((cellRef) => build(cellRef, io, authInfo)),
      ),
    )
}

/** The production credential cache over the Claude Code keychain and the real platform. */
const buildLiveCredentialCache = (
  cellRef: CredentialCacheCellRef<ClaudeCredentials>,
  authInfo: ProviderAuthInfo,
  platform: AnthropicPlatformApi,
): Effect.Effect<CredentialCache<ClaudeCredentials>> =>
  Effect.suspend(() => build(cellRef, realIO, authInfo)).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(Layer.merge(BunServices.layer, Layer.succeed(AnthropicPlatform, platform))),
  )

/** What the user does when the Claude Code sign-in no longer works. */
const CLAUDE_SIGN_IN_HINT = "Run `claude` to sign in again, then choose Claude Code in /auth."

const build = (
  cellRef: CredentialCacheCellRef<ClaudeCredentials>,
  io: AnthropicCredentialIO,
  authInfo?: ProviderAuthInfo,
): Effect.Effect<CredentialCache<ClaudeCredentials>, never, AnthropicCredentialIORequirements> =>
  Effect.gen(function* () {
    const ioContext = yield* Effect.context<AnthropicCredentialIORequirements>()
    const read = io.read.pipe(Effect.provideContext(ioContext))
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
      // A refresh failure keeps its own reason (locked keychain, access
      // denied, OAuth 4xx); only a refresh that returns an expired token
      // gets the generic hint.
      refresh: (held) =>
        Effect.gen(function* () {
          const refreshed = yield* io.refresh(held).pipe(
            Effect.provideContext(ioContext),
            Effect.mapError((cause): CredentialFailure => {
              if (cause._tag === "CredentialRefreshUnavailable") return cause
              return new ProviderAuthError({
                message: `Claude Code sign-in failed: ${cause.message}. ${CLAUDE_SIGN_IN_HINT}`,
                cause,
              })
            }),
          )
          const now = yield* Clock.currentTimeMillis
          if (freshEnoughForUse(refreshed, now)) return refreshed
          return yield* new ProviderAuthError({
            message: `Claude Code credentials are expired. ${CLAUDE_SIGN_IN_HINT}`,
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

type KeychainTransformRequirements = Crypto.Crypto | AnthropicPlatform

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
 * Drop orphan `tool_use` blocks (no
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
 * A single block carrying `IDENTITY + "\n\n<rest>"` (the shape
 * OpenCode's `system.transform` hook produces) is split at the identity
 * boundary: identity goes to identityBlocks,
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
 * The caller MUST pass the FINAL post-relocation messages so
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
 * Anthropic's OAuth-billing path
 * validates `system[]` against the Claude Code identity prefix.
 * Third-party system content alongside the prefix trips a 400 "out of
 * extra usage" rejection. The relocator takes the third-party blocks
 * (already partitioned by `partitionSystemBlocks`) and folds them into
 * the first user message as a single text block.
 *
 * Ordering rules:
 *   - tool_result ordering: Anthropic requires tool_result blocks to be
 *     the FIRST blocks of a user message that carries any. Inserting
 *     text at index 0 in such a message produces 400. We splice the
 *     relocated text in AFTER the leading run of tool_result blocks.
 *   - billing freshness: this runs BEFORE buildSystemArray so the
 *     billing hash is computed from the FINAL first-user text, and the
 *     wire hash matches the wire text.
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
 * Strip the effort knob for models that do not support it (the
 * override table sets `disableEffort` for the haiku family). Anthropic returns 400 if
 * effort is sent with a haiku model. We strip from BOTH
 * `output_config.effort` (the shape gent emits) AND `thinking.effort`
 * (the shape the upstream Anthropic SDK may emit in future versions —
 * matches the opencode reference). Each branch deletes the parent
 * object if it empties out.
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

/**
 * Wraps an AnthropicClient to apply Claude Code keychain conventions. A
 * request that fails on its credential keeps the credential's own message.
 */
const makeKeychainClientLayer = (
  creds: CredentialCache<ClaudeCredentials>,
): Layer.Layer<
  AnthropicClient.AnthropicClient,
  never,
  AnthropicClient.AnthropicClient | KeychainTransformRequirements
> =>
  Layer.effect(
    AnthropicClient.AnthropicClient,
    Effect.gen(function* () {
      const inner = yield* AnthropicClient.AnthropicClient
      const explain = explainCredentialFailure(creds)
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
            return yield* explain(
              inner.createMessage({
                ...options,
                payload: encodeMessagePayload(decodeMessagePayload(transformed)),
              }),
            )
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
            return yield* explain(
              inner.createMessageStream({
                ...options,
                payload: encodeMessagePayload(decodeMessagePayload(transformed)),
              }),
            )
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
 * The middleware stack, layered outside-in via `pipe`:
 *   - mapRequestEffect (preprocess) — auth + cache-aware headers
 *   - long-context beta retry (inner transformResponse)
 *   - 401 recovery (outer) — invalidate creds + retry once
 *
 * There is no 429/529/5xx or transport retry here. The SDK maps those to
 * retryable `AiError`s, and the agent loop owns that retry under the
 * driver's policy: it honors `retry-after` and reports each attempt.
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
 */

// ── Typed errors ──

/**
 * Internal error driving the long-context beta retry. Carries the response
 * so the catch-tag can hand the final 400 back to the caller. `response` is
 * `Schema.Any` because `HttpClientResponse` is a vendor class; the typed
 * accessor `getResponse` re-narrows it.
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
  // The billing header lives in `system[0]` (see `buildSystemArray`),
  // NOT as an HTTP header. We do set this declarative
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
      // retry slot per long-context candidate the model actually emits.
      // When candidates exhaust, the catch-tag
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
 * to the keychain transform middleware (auth headers, long-context beta
 * retry, 401 recovery). Uses `Layer.unwrap` because the transform
 * factory needs the beta cache instance at construction time.
 *
 * `resolveModel` builds the credential cache, and this layer builds the
 * beta cache, over cells the Effectful `modelDrivers()` setup allocates
 * once. Cells allocated per layer build would reset both caches, killing
 * cross-request beta learning and credential reuse.
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
  creds: CredentialCache<ClaudeCredentials>,
  betaCellRef: Ref.Ref<BetaCacheCell>,
  platform: AnthropicPlatformApi,
) => {
  const cacheLayer = AnthropicBetaCache.layerFromRef(betaCellRef)

  const clientLayer = Layer.unwrap(
    Effect.gen(function* () {
      const cache = yield* AnthropicBetaCache
      return AnthropicClient.layer({
        transformClient: buildKeychainTransformClient(creds, cache, platform.env),
      }).pipe(Layer.provide(FetchHttpClient.layer))
    }),
  ).pipe(Layer.provide(cacheLayer))

  const wrappedClient = makeKeychainClientLayer(creds).pipe(
    Layer.provide(clientLayer),
    Layer.provide(BunCrypto.layer),
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
  catalog: CatalogSource,
): ModelDriverContribution => ({
  id: "anthropic",
  name: "Anthropic",
  listModels: driverListModels(catalog, "anthropic"),
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

      // OAuth path: the credential cache and the beta cache are built over
      // the extension-closure-owned cells, so cross-request beta learning
      // and credential reuse survive. The credentials are checked before
      // the layer exists, so an expired sign-in fails with its own message.
      const creds = yield* buildLiveCredentialCache(credentialCellRef, auth.value, platform)
      yield* checkCredentials(creds)
      return AiModel.make(
        "anthropic",
        modelName,
        makeOauthAnthropicLayer(modelName, config, creds, betaCellRef, platform),
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
        // The Claude Code authorize flow reads the primary account.
        let creds = yield* readClaudeCodeCredentials
        const now = yield* Clock.currentTimeMillis
        if (!freshEnoughForUse(creds, now)) {
          // Use the returned creds — re-reading keychain after refresh
          // would silently lose direct-OAuth tokens whenever write-back
          // failed.
          creds = yield* refreshClaudeCodeCredentials(Option.none()).pipe(
            Effect.mapError((cause) => {
              if (cause._tag === "ProviderAuthError") return cause
              return new ProviderAuthError({ message: cause.message, cause })
            }),
          )
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

    const catalog = yield* catalogSource(ctx.home)

    yield* ctx.register(
      "modelDriver",
      buildAnthropicModelDriver(credentialCellRef, betaCellRef, envApiKey, platform, catalog),
    )
  }),
})
