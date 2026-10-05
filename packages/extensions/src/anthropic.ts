import {
  Cause,
  Clock,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import { Hex } from "effect/encoding"
import {
  type ApiClassContribution,
  type ApiEndpoint,
  AuthMethod,
  type CatalogModel,
  type CatalogOverride,
  DEFAULT_RETRY_POLICY,
  defineExtension,
  ExtensionHost,
  type ExtensionHostService,
  type FailureResponse,
  isRecord,
  isRecordArray,
  type JsonRecord,
  Model,
  type ModelDriverContribution,
  ProviderAuthError,
  DEFAULT_CREDENTIAL_SLOT,
  type UpdateStoredOAuth,
  type StoredOAuthCredentials,
  type ProviderAuthorizationResult,
  type ProviderHints,
  acceptedEfforts,
  clampEffort,
  ReasoningEffort,
  rateLimitResponse,
  reportProviderStopReason,
  retryAfterAt,
  type RunEffort,
  runProcess,
  writeFileAtomic,
} from "@gent/core/extensions/api"
import {
  adapterEntry,
  catalogModels,
  type CredentialCache,
  CredentialCacheCell,
  credentialCells,
  replaceHeldCredential,
  type CredentialCacheCellRef,
  type CredentialFailure,
  checkCredentials,
  CredentialRefreshUnavailable,
  type EffortCarrier,
  effortCarrier,
  keepsEffortPrefix,
  effortFor,
  EMPTY_CREDENTIAL_CELL,
  hasToggle,
  lowestEffort,
  maxTokensOf,
  modelReasons,
  reasoningHint,
  sdkApiKey,
  thinkingBudget,
  explainCredentialFailure,
  authorizedClient,
  freshEnoughAt,
  isCacheableBlock,
  isHostContextUpdate,
  isTransientTokenStatus,
  makeCredentialCache,
  postOAuthForm,
  apiKeyFrom,
  readOptionalEnv,
  requestJsonObject,
  withHeaders,
  writesPromptCache,
  MessagesTransientStreamEvent,
  ModelHttpClient,
  latestReset,
  spentLimitsReset,
} from "./providers.js"
import { ChildProcessSpawner } from "effect/process"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/http"
import type { AnthropicClient, AnthropicLanguageModel, Generated } from "@effect/ai-anthropic"
import type * as AnthropicSdkModule from "@effect/ai-anthropic"
import { type AiError, Model as AiModel, type Response } from "effect/ai"

/**
 * The SDK, loaded by the first model build: its generated schemas cost a
 * launch time to evaluate, and a launch that streams nothing never reads them.
 */
type AnthropicSdk = typeof AnthropicSdkModule
// oxlint-disable-next-line effect/noDynamicImports -- the SDK loads at the first model build, not at launch
const loadAnthropicSdk = Effect.promise((): Promise<AnthropicSdk> => import("@effect/ai-anthropic"))

// Test seam: only tests read these exports. The model beta lookup
// (getModelBetas), the billing header (SYSTEM_IDENTITY_PREFIX,
// extractFirstUserMessageText, buildBillingHeaderValue), the wire transforms (transformPayload, transformResponseContent, transformStreamEvent)
// and the credential parsers (ClaudeCredentials,
// updateCredentialBlob, parseOAuthResponse) are pure functions with unit tests.
// AnthropicKeychainEnv, AnthropicPlatform, AnthropicCredentialIO,
// makeAnthropicCredentialCache and buildAnthropicModelDriver let a test run the
// keychain, the credential cache and the driver against fake I/O.
// readPromptCacheTtl lets a test read the cache-lifetime switch from its own config.

// ── model config ────────────────────────────────────────────────────────────

/**
 * Per-model Anthropic configuration — beta flags, ccVersion, and
 * model-specific overrides, in one place. Follows
 * `griffinmartin/opencode-claude-auth/src/model-config.ts`.
 *
 * The override table is matched first-match-wins by `String.includes`
 * against the lowercased model id: `"haiku"` names a family, `"4-6"` a
 * version of any family. A model both keys match takes only the first.
 *
 * @module
 */

interface ModelOverride {
  /** Beta flags to remove from the base list for this model. */
  readonly exclude?: ReadonlyArray<string>
  /** Beta flags to add for this model on top of the base list. */
  readonly add?: ReadonlyArray<string>
}

interface ModelConfig {
  readonly ccVersion: string
  readonly baseBetas: ReadonlyArray<string>
  readonly modelOverrides: Record<string, ModelOverride>
}

/**
 * Single source of truth for Anthropic model billing / beta config.
 * Keep aligned with Claude Code's currently-advertised version + beta
 * set; reference at
 * `~/.cache/repo/griffinmartin/opencode-claude-auth/src/model-config.ts`.
 */
const MODEL_CONFIG: ModelConfig = {
  ccVersion: "2.1.280",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
  ],
  // No `context-1m`: every 1M-window model has 1M by default with no beta
  // (platform.claude.com/docs/en/build-with-claude/context-windows, read
  // 2026-09-23).
  modelOverrides: {
    haiku: {
      exclude: ["interleaved-thinking-2025-05-14"],
    },
    "4-6": {
      add: ["effort-2025-11-24"],
    },
    "4-7": {
      add: ["effort-2025-11-24"],
    },
  },
}

/** First-match-wins lookup against the override table, in its insertion order. */
const getModelOverride = (modelId: string): Option.Option<ModelOverride> => {
  const lower = modelId.toLowerCase()
  for (const [pattern, override] of Object.entries(MODEL_CONFIG.modelOverrides)) {
    if (lower.includes(pattern)) return Option.some(override)
  }
  return Option.none()
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
 *   2. apply per-model `exclude` / `add` from `getModelOverride`.
 */
export const getModelBetas = (
  modelId: string,
  envBaseBetas: Option.Option<string>,
): ReadonlyArray<string> => {
  const baseRaw = Option.getOrElse(envBaseBetas, () => MODEL_CONFIG.baseBetas.join(","))
  const betas = baseRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  applyModelOverride(betas, getModelOverride(modelId))
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
   * `host.homeDirectory` (the OS user home), not `ctx.home` (the home gent
   * runs with, which a host may set elsewhere): the Claude Code credential
   * file lives at the OS user's home whatever `ctx.home` is. This is the one
   * place that picks the field.
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
    return Hex.encode(digest)
  })

/**
 * Compute `cch` — first 5 hex chars of `sha256(messageText)`. The
 * Anthropic billing-validation step rejects requests whose `cch`
 * doesn't match the first user message we send, so this MUST be
 * recomputed per request.
 */
const computeCch = (messageText: string): Effect.Effect<string, never, Crypto.Crypto> =>
  sha256Hex(messageText).pipe(Effect.map((hex) => hex.slice(0, 5)))

/**
 * Compute the 3-char version suffix appended to `cc_version`. Samples
 * characters at indices 4, 7, 20 of the message text (zero-padded when
 * the message is shorter), prepends the billing salt + version string,
 * then hashes the lot. Anthropic checks this against the version we
 * advertise in the same header.
 */
const computeVersionSuffix = (
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
 * valid JSON.
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
 * Anthropic's observed token lifetime.
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

export const SYSTEM_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

/**
 * CLI version: the live env wins, otherwise the `MODEL_CONFIG.ccVersion`
 * baseline. Pure function — env comes from the caller's `AnthropicPlatform`.
 */
const getCliVersion = (env: AnthropicKeychainEnv): string =>
  env.cliVersion ?? MODEL_CONFIG.ccVersion

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
 * The request body's `model`, which picks the model's beta headers;
 * "unknown" when the body is not JSON or names no model.
 */
const requestModelId = (req: HttpClientRequest.HttpClientRequest): string =>
  requestJsonObject(req).pipe(
    Option.flatMap((body) => Option.fromUndefinedOr(body["model"])),
    Option.filter(Predicate.isString),
    Option.getOrElse(() => "unknown"),
  )

// ── oauth credentials file ──────────────────────────────────────────────────

const credentialsFilePath = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(home, ".claude", ".credentials.json")
  })

const credentialFileDeadline = <A, R>(io: Effect.Effect<A, ProviderAuthError, R>) =>
  io.pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () => new ProviderAuthError({ message: "Claude credentials file IO timed out" }),
    }),
  )

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
}).pipe(credentialFileDeadline)

/** Two stored credentials, or their absence, are the same sign-in at the same rotation. */
const sameStoredCredential = Option.makeEquivalence(Schema.toEquivalence(ClaudeCredentials))

/**
 * What a write-back found. `Kept` means the store still held a credential
 * the refresh started from, so the refreshed one is the one to use (whether
 * or not the blob took the splice). `Superseded` means another writer
 * changed the store during the refresh; its credential wins.
 */
const WriteBack = Schema.TaggedUnion({
  Kept: {},
  Superseded: { stored: Schema.Option(ClaudeCredentials) },
})
type WriteBack = typeof WriteBack.Type

/**
 * What a refresh started from: the credential whose refresh token was sent
 * (`sent`), and what the pre-refresh store read found (`read`, none when that
 * read failed). The read is always tried first, so when it differs from
 * `sent` its token was refused.
 */
interface RefreshBase {
  readonly read: Option.Option<ClaudeCredentials>
  readonly sent: ClaudeCredentials
}

/**
 * Whether the store may take the refresh. It may when it holds the credential
 * whose token was sent, or still holds what the pre-refresh read found (no
 * writer came in between), or, when that read failed, is still empty (a first
 * write). Anything else is a newer writer: the held credential is not a base,
 * since a sign-in to the held account during the refresh equals it.
 */
const refreshStartedFrom = (stored: Option.Option<ClaudeCredentials>, base: RefreshBase): boolean =>
  Option.match(stored, {
    onNone: () => Option.isNone(base.read),
    onSome: (credential) =>
      sameStoredCredential(stored, base.read) ||
      Schema.toEquivalence(ClaudeCredentials)(credential, base.sent),
  })

/**
 * Splice `creds` into the stored blob `raw`, but only while it still holds
 * the base the refresh started from (`refreshStartedFrom`). Another writer (a
 * new sign-in, the `claude` CLI's own refresh) wins over this refresh.
 */
const compareAndWrite = <E, R>(
  raw: string,
  creds: ClaudeCredentials,
  base: RefreshBase,
  write: (blob: string) => Effect.Effect<void, E, R>,
): Effect.Effect<WriteBack, E, R> =>
  Effect.gen(function* () {
    const stored = yield* Effect.option(decodeCredentials(raw))
    if (!refreshStartedFrom(stored, base)) {
      return WriteBack.cases.Superseded.make({ stored })
    }
    const updated = updateCredentialBlob(raw, creds)
    if (Option.isSome(updated)) yield* write(updated.value)
    return WriteBack.cases.Kept.make({})
  })

const writeCredentialsFile = (
  creds: ClaudeCredentials,
  base: RefreshBase,
): Effect.Effect<
  WriteBack,
  ProviderAuthError,
  AnthropicPlatform | FileSystem.FileSystem | Path.Path
> =>
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
    // Staged and renamed over the file, owner-only from the first byte: the
    // claude CLI reading it at the same time sees the old or the new blob.
    return yield* compareAndWrite(raw, creds, base, (blob) =>
      writeFileAtomic(credentialsFile, blob, { mode: 0o600 }).pipe(Effect.mapError(mapFsError)),
    )
  }).pipe(credentialFileDeadline)

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
 * The write is a compare-and-swap: it re-reads the stored blob and writes
 * only while it still holds the credential whose refresh token was sent, or
 * what the pre-refresh read found. A sign-in (or a CLI refresh) written
 * meanwhile is newer than this refresh, so it survives and the result names
 * it, even when it equals the held credential.
 *
 * Errors are surfaced as `ProviderAuthError` for the caller to log:
 * write-back is best-effort; the in-memory creds are authoritative for
 * the in-flight request.
 */
const writeBackCredentials = (
  creds: ClaudeCredentials,
  base: RefreshBase,
): Effect.Effect<
  WriteBack,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    if (platform.platform !== "darwin") {
      return yield* writeCredentialsFile(creds, base)
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
    return yield* compareAndWrite(raw, creds, base, (blob) =>
      Effect.gen(function* () {
        const accountName = Option.getOrElse(
          yield* getKeychainAccountName(CLAUDE_KEYCHAIN_SERVICE),
          () => CLAUDE_KEYCHAIN_SERVICE,
        )
        yield* writeKeychainEntry(CLAUDE_KEYCHAIN_SERVICE, accountName, blob)
      }),
    )
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
const refreshViaOAuthClient = (
  refreshToken: string,
): Effect.Effect<ClaudeCredentials, CredentialFailure, HttpClient.HttpClient> =>
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
  })

/** Legacy primary source retains its existing HTTP boundary. */
const refreshViaOAuth = (
  refreshToken: string,
): Effect.Effect<ClaudeCredentials, CredentialFailure> =>
  refreshViaOAuthClient(refreshToken).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- the credential read owns its HTTP client at the extension boundary; it outlives no scope.
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
    const read = Exit.getSuccess(current)
    // The stored credential first, then the held one; each refresh token once.
    const candidates = [read, held]
      .flatMap((candidate) => Option.toArray(candidate))
      .filter(
        (candidate, index, all) =>
          candidate.refreshToken !== "" &&
          all.findIndex((other) => other.refreshToken === candidate.refreshToken) === index,
      )
    if (candidates.length === 0) failures.push("no stored refresh token")
    for (const sent of candidates) {
      const refreshed = yield* Effect.exit(rotateAndWriteBack({ read, sent }))
      if (Exit.isSuccess(refreshed)) return refreshed.value
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
    // primary one read here. The CLI rotates and stores the token itself,
    // so a caller may stop it even inside the credential cache's
    // uninterruptible refresh step.
    const platform = yield* AnthropicPlatform
    return yield* spawnClaudeCli(platform.home).pipe(
      Effect.retry({ times: 1 }),
      Effect.andThen(readClaudeCodeCredentials),
      Effect.mapError((cause): CredentialFailure => {
        const message = `${failures.join("; ")}; CLI fallback: ${cause.message}`
        if (endpointUnavailable) return new CredentialRefreshUnavailable({ message, cause })
        return new ProviderAuthError({ message, cause })
      }),
      Effect.interruptible,
    )
  })

/**
 * One direct OAuth refresh and its write-back, as one step a caller cannot
 * stop: the token endpoint spends the refresh token it is sent, so a
 * rotation stopped before the write-back would leave the keychain only the
 * spent token. Timeouts bound the token request and interruptible keychain
 * IO. Masked filesystem acquisition and finalizers can still exceed those
 * deadlines; the step waits for them before cancellation surfaces.
 *
 * The write-back is best-effort so later processes pick up the new token. A
 * failed write-back does not lose the refresh: the caller has it in memory.
 */
const rotateAndWriteBack = (base: RefreshBase) =>
  Effect.gen(function* () {
    const refreshed = yield* refreshViaOAuth(base.sent.refreshToken)
    const outcome = yield* writeBackCredentials(refreshed, base).pipe(
      Effect.catchEager((e: ProviderAuthError) =>
        Effect.logWarning("anthropic.oauth.writeback.failed").pipe(
          Effect.annotateLogs({ error: String(e) }),
          Effect.as(WriteBack.cases.Kept.make({})),
        ),
      ),
    )
    // A sign-in written during the refresh is newer: use it, and drop
    // this refresh rather than overwrite it.
    if (outcome._tag === "Superseded" && Option.isSome(outcome.stored)) {
      return outcome.stored.value
    }
    return refreshed
  }).pipe(Effect.uninterruptible)

// ── credential service ──────────────────────────────────────────────────────

/**
 * Claude Code credentials behind the shared credential cache (`makeCredentialCache` in `providers.ts`).
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

/**
 * What the driver runs on: the host's files, paths, processes and crypto, captured
 * once at setup, plus the Claude Code platform facts. The driver provides no
 * platform of its own, so a test host's services reach the keychain reads.
 */
type AnthropicDriverServices = Context.Context<AnthropicCredentialIORequirements | Crypto.Crypto>

/** The production credential cache over the Claude Code keychain and the host's platform. */
const buildLiveCredentialCache = (
  cellRef: CredentialCacheCellRef<ClaudeCredentials>,
  services: AnthropicDriverServices,
): Effect.Effect<CredentialCache<ClaudeCredentials>> =>
  Effect.suspend(() => makeAnthropicCredentialCache(cellRef, realIO)).pipe(
    Effect.provideContext(services),
  )

/** What the user does when the Claude Code sign-in no longer works. */
const CLAUDE_SIGN_IN_HINT = "Run `claude` to sign in again, then choose Claude Code in /auth."

/** The Anthropic credential cache over a cell that outlives one `resolveModel` call. */
export const makeAnthropicCredentialCache = (
  cellRef: CredentialCacheCellRef<ClaudeCredentials>,
  io: AnthropicCredentialIO,
): Effect.Effect<CredentialCache<ClaudeCredentials>, never, AnthropicCredentialIORequirements> =>
  Effect.gen(function* () {
    const ioContext = yield* Effect.context<AnthropicCredentialIORequirements>()
    const read = io.read.pipe(Effect.provideContext(ioContext))
    const cache = yield* makeCredentialCache<ClaudeCredentials>({
      label: "Anthropic",
      credentials: ClaudeCredentials,
      cellRef,
      expiresAt: (creds) => creds.expiresAt,
      // A keychain miss surfaces as ProviderAuthError; swallowing it
      // turns the miss into a refresh attempt instead of a failure.
      read: Option.some(() => Effect.option(read)),
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
          if (freshEnoughAt(refreshed.expiresAt, now)) return refreshed
          return yield* new ProviderAuthError({
            message: `Claude Code credentials are expired. ${CLAUDE_SIGN_IN_HINT}`,
          })
        }),
      // The keychain is the source of truth, and the refresh writes it.
      // The stored `oauth` entry only selects this path; nothing reads its
      // tokens, so a refresh is not written there.
      store: Option.none(),
    })
    return cache
  })

/** Named imports belong to Gent, never to the primary external source. */
const buildNamedCredentialCache = (
  cellRef: CredentialCacheCellRef<ClaudeCredentials>,
  update: UpdateStoredOAuth,
  services: AnthropicDriverServices,
) =>
  makeCredentialCache<ClaudeCredentials>({
    label: "Imported Claude Code",
    credentials: ClaudeCredentials,
    cellRef,
    expiresAt: (creds) => creds.expiresAt,
    refresh: (held) =>
      Effect.gen(function* () {
        if (Option.isNone(held) || held.value.refreshToken === "") {
          return yield* new ProviderAuthError({
            message: "Imported Claude Code credential unavailable; import it again",
          })
        }
        const client = Context.getOption(services, HttpClient.HttpClient)
        return yield* Option.match(client, {
          onNone: () => refreshViaOAuth(held.value.refreshToken),
          onSome: (http) =>
            refreshViaOAuthClient(held.value.refreshToken).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
            ),
        }).pipe(
          Effect.catchTags({
            ProviderAuthError: () =>
              Effect.fail(
                new ProviderAuthError({
                  message: "Imported Claude Code credential rejected; import it again",
                }),
              ),
            CredentialRefreshUnavailable: () =>
              Effect.fail(
                new CredentialRefreshUnavailable({
                  message: "Imported Claude Code credential refresh unavailable; retry later",
                }),
              ),
          }),
        )
      }),
    read: Option.none(),
    store: Option.some({
      update: <A, E>(
        f: (
          stored: Option.Option<ClaudeCredentials>,
        ) => Effect.Effect<readonly [A, Option.Option<ClaudeCredentials>], E>,
      ) =>
        update((stored) =>
          Effect.map(
            f(
              Option.map(stored, (value) => ({
                accessToken: value.access,
                refreshToken: value.refresh,
                expiresAt: value.expires,
              })),
            ),
            (pair): readonly [A, Option.Option<StoredOAuthCredentials>] => [
              pair[0],
              Option.map(pair[1], (value) => ({
                access: value.accessToken,
                refresh: value.refreshToken,
                expires: value.expiresAt,
              })),
            ],
          ),
        ),
      same: (a, b) => a.refreshToken === b.refreshToken,
    }),
  })

/** Explicit directory import never falls back to a keychain or another home. */
const readImportedCredentials = (
  directory: string,
): Effect.Effect<ClaudeCredentials, ProviderAuthError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    if (!path.isAbsolute(directory))
      return yield* new ProviderAuthError({
        message: "Claude Code import needs an absolute directory",
      })
    const fs = yield* FileSystem.FileSystem
    const raw = yield* fs.readFileString(path.join(directory, ".credentials.json")).pipe(
      Effect.mapError(
        () =>
          new ProviderAuthError({
            message: "Claude Code import source unavailable; choose a directory with a login",
          }),
      ),
    )
    return yield* decodeCredentials(raw).pipe(
      Effect.mapError(
        () =>
          new ProviderAuthError({
            message: "Claude Code import source invalid; sign in there again",
          }),
      ),
    )
  }).pipe(credentialFileDeadline)

// ── keychain client ─────────────────────────────────────────────────────────

/**
 * AnthropicClient wrapper for Claude Code keychain mode.
 *
 * Intercepts createMessage/createMessageStream to apply:
 * - mcp_ tool name prefix on outgoing payloads
 * - mcp_ tool name strip on incoming responses
 * - System identity injection
 * - Prompt-cache markers (`markCacheBreakpoints`)
 *
 * This keeps all Claude Code keychain conventions in the extension,
 * out of the generic provider boundary.
 */

type KeychainTransformRequirements = Crypto.Crypto | AnthropicPlatform

// ── Constants ──

const MCP_PREFIX = "mcp_"
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header"
/** Reads a wire value (a response body, a stream event) as a `JsonRecord`; a non-record throws. */
const decodeJsonRecord = Schema.decodeSync(Schema.Record(Schema.String, Schema.Unknown))
const JsonValueSchema = Schema.Unknown
type JsonValue = Schema.Schema.Type<typeof JsonValueSchema>

// ── Payload Transforms (outgoing) ──

/**
 * Prefix tool names with `mcp_` AND uppercase the first letter — Claude
 * Code uses PascalCase tool names (`mcp_Bash`, `mcp_Read`); lowercase
 * names trip the Anthropic OAuth-billing validation when multiple tools
 * are present (verified in opencode-claude-auth issue notes).
 */
const prefixName = (name: string): string =>
  `${MCP_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`

/**
 * Reverse `prefixName`. The request's own tool ids decide: `prefixName` loses
 * the case of an id's first letter. A name no request tool produced drops
 * `mcp_` and lowercases its first letter.
 */
const unprefixName = (toolIds: ReadonlyArray<string>, name: string): string => {
  const id = toolIds.find((candidate) => prefixName(candidate) === name)
  if (Predicate.isNotUndefined(id)) return id
  let stripped = name
  if (name.startsWith(MCP_PREFIX)) stripped = name.slice(MCP_PREFIX.length)
  return `${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}`
}

/** The tool ids a request advertised, before `transformTools` prefixed them. */
const requestToolIds = (
  payload: Parameters<AnthropicClient.Service["createMessage"]>[0]["payload"],
): ReadonlyArray<string> =>
  (payload.tools ?? []).flatMap((tool) => {
    if ("name" in tool && Predicate.isString(tool.name)) return [tool.name]
    return []
  })

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
 * The caller's system blocks the relocator moves into the first user
 * message: every block but the billing entries (re-computed per request)
 * and the identity prefix, which `buildSystemArray` writes itself.
 *
 * A single block carrying `IDENTITY + "\n\n<rest>"` (the shape
 * OpenCode's `system.transform` hook produces) is split at the identity
 * boundary, and only the remainder moves.
 */
const thirdPartySystemBlocks = (callerSystem: JsonValue): ReadonlyArray<JsonRecord> =>
  stripExistingBillingBlocks(normalizeSystemBlocks(callerSystem)).flatMap((block) => {
    const text = block["text"]
    if (!Predicate.isString(text) || !text.startsWith(SYSTEM_IDENTITY_PREFIX)) return [block]
    const rest = text.slice(SYSTEM_IDENTITY_PREFIX.length).replace(/^\n+/, "")
    if (rest.length === 0) return []
    return [{ ...block, text: rest }]
  })

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
 * (`thirdPartySystemBlocks`) and moves them into the first user message,
 * one text block each, before the user's own text. The runtime sends the
 * prompt as the part a session shares with its children, then the agent's
 * own part: the shared part leads the message, so the billing hash of the
 * first text block and every byte through the shared part are the same for
 * a parent and its children.
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
 * Returns the new messages and the number of blocks the system prompt
 * takes in the first user message; mutates nothing.
 */
const relocateThirdPartyIntoFirstUser = (
  thirdPartyBlocks: ReadonlyArray<JsonRecord>,
  messages: ReadonlyArray<JsonRecord>,
): RelocatedPrompt => {
  const unmoved = { messages, blocks: 0 }
  const movedTexts: string[] = []
  for (const block of thirdPartyBlocks) {
    const text = block["text"]
    if (Predicate.isString(text) && text.length > 0) movedTexts.push(text)
  }
  if (movedTexts.length === 0) return unmoved

  const firstUserIdx = messages.findIndex((m) => m["role"] === "user")
  if (firstUserIdx === -1) return unmoved

  const firstUser = Option.fromUndefinedOr(messages[firstUserIdx])
  if (Option.isNone(firstUser)) return unmoved
  const firstUserValue = firstUser.value
  const content = firstUserValue["content"]
  const nextMessages = messages.slice()

  // A string content takes no marker, so the prompt joins into it.
  if (Predicate.isString(content)) {
    const prefix = movedTexts.join("\n\n")
    nextMessages[firstUserIdx] = { ...firstUserValue, content: `${prefix}\n\n${content}` }
    return { messages: nextMessages, blocks: 0 }
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
        ...movedTexts.map((text) => ({ type: "text", text })),
        ...content.slice(firstNonToolResult),
      ],
    }
    return { messages: nextMessages, blocks: movedTexts.length }
  }
  // Unknown content shape — bail out rather than mangling it.
  return unmoved
}

/** The messages after relocation, and how many blocks the system prompt takes in the first user message. */
interface RelocatedPrompt {
  readonly messages: ReadonlyArray<JsonRecord>
  readonly blocks: number
}

/**
 * Apply every outgoing OAuth-billing transform. Order is load-bearing —
 * relocation MUST run BEFORE billing computation because the relocator
 * changes the first-user message text and the billing hash MUST match
 * what's on the wire:
 *
 *   1. transformTools — PascalCase mcp_ prefix on tool names.
 *   2. transformMessages — PascalCase mcp_ prefix on tool_use blocks
 *      in history. Core's model-context validation already fails a turn
 *      with an orphan tool call or result, so none reaches this point.
 *   3. transformToolChoice — independent.
 *   4. relocateThirdPartyIntoFirstUser — pull non-billing/non-identity
 *      system blocks into the first user message FIRST, so the
 *      billing hash in step 5 sees the final wire text.
 *   5. buildSystemArray — compute billing from FINAL (post-relocation)
 *      messages; emit the strict `[billing, identity]` system shape.
 */
export const transformPayload = (
  payload: JsonRecord,
  cacheLifetimes: Option.Option<CacheLifetimes>,
): Effect.Effect<JsonRecord, never, KeychainTransformRequirements> =>
  Effect.gen(function* () {
    let result = { ...payload }

    if (isRecordArray(result["tools"])) {
      result["tools"] = transformTools(result["tools"])
    }

    if (isRecordArray(result["messages"])) {
      result["messages"] = transformMessages(result["messages"])
    }

    if ("tool_choice" in result) {
      result["tool_choice"] = transformToolChoice(result["tool_choice"])
    }

    const thirdPartyBlocks = thirdPartySystemBlocks(result["system"])
    let relocated: RelocatedPrompt = { messages: [], blocks: 0 }
    if (isRecordArray(result["messages"])) {
      relocated = relocateThirdPartyIntoFirstUser(thirdPartyBlocks, result["messages"])
    }
    result["messages"] = relocated.messages
    result["system"] = yield* buildSystemArray(relocated.messages)

    return markRequestCache(
      result,
      CachePrefixEnd.cases.FirstUser.make({ blocks: relocated.blocks }),
      cacheLifetimes,
    )
  })

// ── Prompt caching ──

/**
 * Anthropic caches a prompt prefix only up to a block that carries
 * `cache_control`, and the SDK sets one only from a per-part
 * `options.anthropic.cacheControl`. The prefix renders `tools` →
 * `system` → `messages`, and a request takes at most 4 markers.
 *
 * Markers, in priority order, while the limit allows:
 *   1. the end of the system prompt: the last system block, or on the
 *      Claude Code path the last of the system prompt's blocks in the first
 *      user message (they move there, before the user's own text, and the
 *      billing and identity blocks take no marker). A new session of the
 *      same agent reads the prompt back from this entry;
 *   2. the last cacheable block of the last conversation message, so each
 *      step reads the previous step's conversation back from the cache. A
 *      host context update after it (a later system message, which the SDK
 *      sends as a `<host-context-update>` user message: the runtime's turn
 *      notices) takes no marker. It changes from turn to turn, so a marker
 *      on it would write an entry no later request reads, and the next step
 *      would find no entry at the conversation's end. An effort marker
 *      (`effortMarker`) has no content to mark, so the marker goes on the
 *      message before it;
 *   3. the end of the shared part of the system prompt: the runtime sends
 *      the prompt as two system blocks, the part a session shares with its
 *      children and then the agent's own part (the children guidance, the
 *      host tool list). A fresh child's first request reads the shared part
 *      back from its parent's entry. The marker goes only where the shared
 *      text reaches `SHARED_PREFIX_MIN_CHARS`: a shorter prefix is below the
 *      minimum cacheable length, and the marker would spend a slot for
 *      nothing. On the Claude Code path the blocks keep their order in the
 *      first user message, and the billing header hashes the first of them,
 *      the shared part, so the child's bytes match through it.
 *
 * The tool list takes no marker of its own: it renders first, so the
 * system prompt's marker caches it, and alone it is below the minimum
 * cacheable length (one `cell` tool, about 100 tokens).
 *
 * Markers already on the payload count toward the limit. A marker does
 * not change the cached bytes, so the tail marker moves forward each
 * step, which is the documented multi-turn pattern.
 *
 * `CachePrefixEnd` is where the system prompt sits in the rendered payload: the `system` blocks,
 * or (the Claude Code path) the first `blocks` text blocks of the first user
 * message after any leading tool results.
 */
const CachePrefixEnd = Schema.TaggedUnion({
  System: {},
  FirstUser: { blocks: Schema.Int },
})
type CachePrefixEnd = typeof CachePrefixEnd.Type

const CACHE_BREAKPOINT_LIMIT = 4
/**
 * 1,024 tokens at about 4 characters a token: the minimum cacheable prefix of
 * Sonnet 5 and Opus 4.8 (512 on Opus 5, up to 4,096 on older models). Counted
 * on the system text alone, the tools on top only lengthen the prefix.
 */
const SHARED_PREFIX_MIN_CHARS = 4_096

/**
 * How long a prompt-cache entry lives after the request that writes or reads
 * it. The driver asks for `"1h"`, or for `"5m"` when `ANTHROPIC_PROMPT_CACHE_TTL=5m`.
 * Every marker the driver sets carries it, and the model catalog names it as
 * each model's `promptCacheTtlMs`, so the loop's cold handoff and the TUI's
 * cache notice measure the lifetime the request asked for.
 *
 * 1 hour is the default, decided by the owner (2026-09-30) on a replay of
 * 22.6k of the owner's Claude Code requests: 36.6% of turn starts follow more
 * than 5 minutes idle, and overall the 1-hour lifetime costs 0.79× of the
 * 5-minute one. A 1-hour write costs 2× base input against 1.25× for 5
 * minutes, so a session with no pause pays about 43% more input on 1 hour;
 * such a session sets the switch.
 *
 * A spawned child session (`ProviderHints.child`) runs its steps back to
 * back, so its markers ask for `CHILD_PROMPT_CACHE_TTL`, decided by the owner
 * (2026-09-30). The end of the shared system part keeps the session lifetime:
 * the parent and every sibling read that entry. The catalog names the child
 * lifetime as each model's `childPromptCacheTtlMs`.
 *
 * The Messages API takes `ttl` on `cache_control` with no beta header
 * (`CacheControlEphemeral` in `@effect/ai-anthropic`'s Generated schema). A
 * request must list longer-lived entries before shorter ones. The shared
 * end comes before every other marker, so a request carries the shared
 * lifetime up to it and the request lifetime after it (`CacheLifetimes`), a
 * marker the SDK rendered from a message's own `cacheControl` option too.
 *
 * A write's price follows the lifetime of the entry it wrote, not the
 * session's: the catalog names a rate for each lifetime
 * (`ModelPricing.cacheWriteByLifetime`), and the driver splits each
 * response's writes by lifetime from the usage the API reports
 * (`cache_creation`), so a child's 5-minute writes and a mixed request's
 * 1-hour shared part each cost their own rate. `cacheWrite` stays the session
 * lifetime's rate, for a response that reports no split.
 */
type PromptCacheTtl = NonNullable<Generated.CacheControlEphemeral["ttl"]>

const PROMPT_CACHE_TTL = Schema.Literals(["5m", "1h"])
const DEFAULT_PROMPT_CACHE_TTL: PromptCacheTtl = "1h"
const CHILD_PROMPT_CACHE_TTL: PromptCacheTtl = "5m"

/**
 * The lifetimes of one request's markers: `shared` for the tools and the
 * system prompt through its shared part, `request` for every marker after.
 */
interface CacheLifetimes {
  readonly request: PromptCacheTtl
  readonly shared: PromptCacheTtl
}

/** A root session's markers all ask for `ttl`; a child's ask for the child lifetime past the shared part. */
const cacheLifetimes = (ttl: PromptCacheTtl, child: boolean): CacheLifetimes => {
  if (!child) return { request: ttl, shared: ttl }
  return { request: shorterPromptCacheTtl(ttl, CHILD_PROMPT_CACHE_TTL), shared: ttl }
}
const PROMPT_CACHE_LIFETIME = {
  "5m": Duration.minutes(5),
  "1h": Duration.hours(1),
} satisfies Record<PromptCacheTtl, Duration.Duration>

const shorterPromptCacheTtl = (a: PromptCacheTtl, b: PromptCacheTtl): PromptCacheTtl => {
  if (Duration.isLessThanOrEqualTo(PROMPT_CACHE_LIFETIME[a], PROMPT_CACHE_LIFETIME[b])) return a
  return b
}

/** The models with the lifetime a child's requests ask for when the session asks for `ttl`. */
const withChildPromptCacheLifetime =
  (ttl: PromptCacheTtl) =>
  (models: ReadonlyArray<Model>): ReadonlyArray<Model> => {
    const lifetime = PROMPT_CACHE_LIFETIME[cacheLifetimes(ttl, true).request]
    return models.map((model) =>
      Model.make({ ...model, childPromptCacheTtlMs: Duration.toMillis(lifetime) }),
    )
  }
/** A cache write's price as a multiple of base input, by lifetime (platform.claude.com prompt-caching pricing). */
const PROMPT_CACHE_WRITE_INPUT_MULTIPLE = {
  "5m": 1.25,
  "1h": 2,
} satisfies Record<PromptCacheTtl, number>

const PROMPT_CACHE_TTLS: ReadonlyArray<PromptCacheTtl> = ["5m", "1h"]

/**
 * The models with a cache write priced at the rate of each lifetime, and at
 * the rate of the lifetime `ttl` names when a response reports no split.
 */
const withPromptCacheWritePrice =
  (ttl: PromptCacheTtl) =>
  (models: ReadonlyArray<Model>): ReadonlyArray<Model> =>
    models.map((model) => {
      if (Predicate.isUndefined(model.pricing)) return model
      const input = model.pricing.input
      const cacheWrite = input * PROMPT_CACHE_WRITE_INPUT_MULTIPLE[ttl]
      const cacheWriteByLifetime = PROMPT_CACHE_TTLS.map((lifetime) => ({
        ttlMs: Duration.toMillis(PROMPT_CACHE_LIFETIME[lifetime]),
        price: input * PROMPT_CACHE_WRITE_INPUT_MULTIPLE[lifetime],
      }))
      return Model.make({
        ...model,
        pricing: { ...model.pricing, cacheWrite, cacheWriteByLifetime },
      })
    })

/** The split of a response's cache writes the Messages API reports in its usage. */
const AnthropicCacheCreation = Schema.Struct({
  anthropic: Schema.Struct({
    usage: Schema.Struct({
      cache_creation: Schema.Struct({
        ephemeral_5m_input_tokens: Schema.Finite,
        ephemeral_1h_input_tokens: Schema.Finite,
      }),
    }),
  }),
})
const decodeAnthropicCacheCreation = Schema.decodeUnknownOption(AnthropicCacheCreation)

/** A response's cache writes by lifetime; empty when its usage reports no split. */
const anthropicCacheWritesByLifetime = (metadata: Response.ProviderMetadata) =>
  Option.match(decodeAnthropicCacheCreation(metadata), {
    onNone: () => [],
    onSome: ({ anthropic }) => {
      const creation = anthropic.usage.cache_creation
      return [
        {
          ttlMs: Duration.toMillis(PROMPT_CACHE_LIFETIME["5m"]),
          tokens: creation.ephemeral_5m_input_tokens,
        },
        {
          ttlMs: Duration.toMillis(PROMPT_CACHE_LIFETIME["1h"]),
          tokens: creation.ephemeral_1h_input_tokens,
        },
      ]
    },
  })

/** The `ANTHROPIC_PROMPT_CACHE_TTL` switch; a value other than `5m` or `1h` is reported and ignored. */
export const readPromptCacheTtl: Effect.Effect<PromptCacheTtl> = Effect.gen(function* () {
  const raw = yield* readOptionalEnv("ANTHROPIC_PROMPT_CACHE_TTL")
  if (Option.isNone(raw)) return DEFAULT_PROMPT_CACHE_TTL
  const ttl = Schema.decodeUnknownOption(PROMPT_CACHE_TTL)(raw.value)
  if (Option.isSome(ttl)) return ttl.value
  yield* Effect.logWarning("ANTHROPIC_PROMPT_CACHE_TTL is not 5m or 1h; using 1h").pipe(
    Effect.annotateLogs({ value: raw.value }),
  )
  return DEFAULT_PROMPT_CACHE_TTL
})

const cacheMarker = (ttl: PromptCacheTtl): JsonRecord => ({ type: "ephemeral", ttl })

const hasCacheMarker = (block: JsonRecord): boolean => isRecord(block["cache_control"])

const countCacheMarkers = (payload: JsonRecord): number => {
  let count = 0
  const countBlocks = (blocks: JsonValue) => {
    if (!isRecordArray(blocks)) return
    for (const block of blocks) if (hasCacheMarker(block)) count += 1
  }
  countBlocks(payload["tools"])
  countBlocks(payload["system"])
  if (isRecordArray(payload["messages"])) {
    for (const message of payload["messages"]) countBlocks(message["content"])
  }
  return count
}

/** The blocks with `index` marked; `None` when there is no such block or it has a marker already. */
const markBlockAt = (
  blocks: ReadonlyArray<JsonRecord>,
  index: number,
  marker: JsonRecord,
): Option.Option<ReadonlyArray<JsonRecord>> =>
  Option.fromUndefinedOr(blocks[index]).pipe(
    Option.filter((block) => !hasCacheMarker(block)),
    Option.map((block) => {
      const next = blocks.slice()
      next[index] = { ...block, cache_control: marker }
      return next
    }),
  )

const markLastCacheable = (blocks: ReadonlyArray<JsonRecord>, marker: JsonRecord) =>
  markBlockAt(blocks, blocks.findLastIndex(isCacheableBlock), marker)

/**
 * The index of the system block that ends the shared part: the cacheable
 * block before the last one, when the text through it is long enough to cache.
 */
const sharedSystemEnd = (system: ReadonlyArray<JsonRecord>): Option.Option<number> => {
  const last = system.findLastIndex(isCacheableBlock)
  const shared = system.slice(0, Math.max(last, 0)).findLastIndex(isCacheableBlock)
  if (shared < 0) return Option.none()
  let chars = 0
  for (const block of system.slice(0, shared + 1)) {
    const text = block["text"]
    if (Predicate.isString(text)) chars += text.length
  }
  if (chars < SHARED_PREFIX_MIN_CHARS) return Option.none()
  return Option.some(shared)
}

/** The blocks with each marker they carry, up to index `through`, replaced by `marker`. */
const withMarkerLifetime = (
  blocks: JsonValue,
  marker: JsonRecord,
  through = Number.POSITIVE_INFINITY,
): JsonValue => {
  if (!isRecordArray(blocks)) return blocks
  return blocks.map((block, index) => {
    if (index > through || !hasCacheMarker(block)) return block
    return { ...block, cache_control: marker }
  })
}

/**
 * The payload with every marker it already carries asking for the request
 * lifetime, and the tool list's for the shared one. The SDK renders a
 * message's `cacheControl` option as a marker of its own, with the 5-minute
 * default; the lifetimes keep the longer-before-shorter ordering rule
 * whatever the order of the markers.
 */
const withRequestLifetimes = (payload: JsonRecord, lifetimes: CacheLifetimes): JsonRecord => {
  const result = { ...payload }
  if ("tools" in payload) {
    result["tools"] = withMarkerLifetime(payload["tools"], cacheMarker(lifetimes.shared))
  }
  const marker = cacheMarker(lifetimes.request)
  if ("system" in payload) result["system"] = withMarkerLifetime(payload["system"], marker)
  const messages = payload["messages"]
  if (isRecordArray(messages)) {
    result["messages"] = messages.map((message) => {
      if (!("content" in message)) return message
      return { ...message, content: withMarkerLifetime(message["content"], marker) }
    })
  }
  return result
}

/**
 * The payload with `cache_control` at the end of the system prompt, on the
 * conversation tail, and at the end of the system prompt's shared part. The
 * shared end asks for the shared lifetime, as does every marker before it;
 * the rest ask for the request lifetime.
 */
const markCacheBreakpoints = (
  rendered: JsonRecord,
  prefixEnd: CachePrefixEnd,
  lifetimes: CacheLifetimes,
): JsonRecord => {
  const marker = cacheMarker(lifetimes.request)
  const sharedMarker = cacheMarker(lifetimes.shared)
  const payload = withRequestLifetimes(rendered, lifetimes)
  const result = { ...payload }
  let budget = CACHE_BREAKPOINT_LIMIT - countCacheMarkers(payload)
  const messages: Array<JsonRecord> = []
  if (isRecordArray(payload["messages"])) messages.push(...payload["messages"])

  const spend = (
    marked: Option.Option<ReadonlyArray<JsonRecord>>,
    set: (blocks: ReadonlyArray<JsonRecord>) => void,
  ) => {
    if (budget <= 0 || Option.isNone(marked)) return
    set(marked.value)
    budget -= 1
  }
  const markMessage = (
    index: number,
    mark: (content: ReadonlyArray<JsonRecord>) => Option.Option<ReadonlyArray<JsonRecord>>,
  ) => {
    const message = Option.fromUndefinedOr(messages[index])
    if (Option.isNone(message)) return
    // The SDK always sends block arrays; a string content takes no marker.
    const content = message.value["content"]
    if (!isRecordArray(content)) return
    spend(mark(content), (marked) => {
      messages[index] = { ...message.value, content: marked }
    })
  }

  const prompt = CachePrefixEnd.match(prefixEnd, {
    System: (): PromptRegion => ({
      read: () => {
        const system = result["system"]
        if (isRecordArray(system)) return system
        return []
      },
      write: (blocks) => {
        result["system"] = blocks
      },
    }),
    FirstUser: ({ blocks }) => firstUserPrompt(messages, blocks),
  })
  spend(markLastCacheable(prompt.read(), marker), prompt.write)
  markMessage(
    messages.findLastIndex((message) => !isHostContextUpdate(message) && !isEffortMarker(message)),
    (content) => markLastCacheable(content, marker),
  )
  const promptBlocks = prompt.read()
  const shared = sharedSystemEnd(promptBlocks)
  if (Option.isSome(shared)) {
    const relabeled = withMarkerLifetime(promptBlocks, sharedMarker, shared.value)
    if (isRecordArray(relabeled)) {
      prompt.write(relabeled)
      spend(markBlockAt(relabeled, shared.value, sharedMarker), prompt.write)
    }
  }
  if (isRecordArray(payload["messages"])) result["messages"] = messages
  return result
}

/** The system prompt's blocks in a payload being marked, read and written in place. */
interface PromptRegion {
  readonly read: () => ReadonlyArray<JsonRecord>
  readonly write: (blocks: ReadonlyArray<JsonRecord>) => void
}

/**
 * The system prompt's blocks on the Claude Code path: the first `blocks`
 * blocks after any leading tool results in the first user message, where
 * `relocateThirdPartyIntoFirstUser` puts them. A write replaces them in
 * `messages`.
 */
const firstUserPrompt = (messages: Array<JsonRecord>, blocks: number): PromptRegion => {
  const index = messages.findIndex((message) => message["role"] === "user")
  // The SDK always sends block arrays; a string content takes no marker.
  const content = (): ReadonlyArray<JsonRecord> => {
    const message = Option.fromUndefinedOr(messages[index])
    if (Option.isNone(message)) return []
    const value = message.value["content"]
    if (isRecordArray(value)) return value
    return []
  }
  // After the leading tool results, as `relocateThirdPartyIntoFirstUser` counts them.
  const start = (blocksNow: ReadonlyArray<JsonRecord>) => {
    const first = blocksNow.findIndex((block) => block["type"] !== "tool_result")
    if (first < 0) return blocksNow.length
    return first
  }
  return {
    read: () => {
      const now = content()
      return now.slice(start(now), start(now) + blocks)
    },
    write: (marked) => {
      const message = Option.fromUndefinedOr(messages[index])
      if (Option.isNone(message)) return
      const now = content()
      messages[index] = {
        ...message.value,
        content: [...now.slice(0, start(now)), ...marked, ...now.slice(start(now) + blocks)],
      }
    },
  }
}

/**
 * The payload marked for the request's cache lifetime. A request with none
 * (its hints carry no `cacheKey`) writes no cache: no later request reads it.
 */
const markRequestCache = (
  rendered: JsonRecord,
  prefixEnd: CachePrefixEnd,
  lifetimes: Option.Option<CacheLifetimes>,
): JsonRecord =>
  Option.match(lifetimes, {
    onNone: () => rendered,
    onSome: (value) => markCacheBreakpoints(rendered, prefixEnd, value),
  })

// ── Response Transforms (incoming) ──

/** Strip mcp_ prefix from tool_use content blocks in a non-streaming response */
export const transformResponseContent = (
  content: ReadonlyArray<JsonRecord>,
  toolIds: ReadonlyArray<string>,
): ReadonlyArray<JsonRecord> =>
  content.map((block) => {
    if (block["type"] === "tool_use" && Predicate.isString(block["name"])) {
      return { ...block, name: unprefixName(toolIds, block["name"]) }
    }
    return block
  })

/** Strip mcp_ prefix from streaming content_block_start events.
 *  MessageStreamEvent uses `type` for the event kind, and `content_block` for the block data. */
export const transformStreamEvent =
  (toolIds: ReadonlyArray<string>) =>
  (event: AnthropicClient.MessageStreamEvent): AnthropicClient.MessageStreamEvent => {
    if (event.type !== "content_block_start") return event
    const block = event.content_block
    if (block.type !== "tool_use") return event
    return { ...event, content_block: { ...block, name: unprefixName(toolIds, block.name) } }
  }

// ── Layer ──

type CreateMessageReply = Effect.Success<ReturnType<AnthropicClient.Service["createMessage"]>>
type CreateMessageStreamReply = Effect.Success<
  ReturnType<AnthropicClient.Service["createMessageStream"]>
>

/** What one auth path adds around the request plan. */
interface ClientPath<R> {
  /** The path's own payload rewrite, run after the request plan is applied. */
  readonly payload: (payload: JsonRecord) => Effect.Effect<JsonRecord, never, R>
  /** Maps the reply; `toolIds` are the tool ids the call's request advertised. */
  readonly message: (
    call: Effect.Effect<CreateMessageReply, AiError.AiError>,
    toolIds: ReadonlyArray<string>,
  ) => Effect.Effect<CreateMessageReply, AiError.AiError>
  readonly stream: (
    call: Effect.Effect<CreateMessageStreamReply, AiError.AiError>,
    toolIds: ReadonlyArray<string>,
  ) => Effect.Effect<CreateMessageStreamReply, AiError.AiError>
}

/** The SDK client layer of one auth path, given the body rewrite to install as its innermost transform. */
type SdkClientLayer = (
  rewriteBody: (client: HttpClient.HttpClient) => HttpClient.HttpClient,
) => Layer.Layer<AnthropicClient.AnthropicClient, never, HttpClient.HttpClient>

/**
 * The raw `stop_reason` goes to the loop (`ProviderStopReason`). The SDK maps
 * a reason its table lacks to `"unknown"` and keeps no copy, and
 * `model_context_window_exceeded` (Sonnet 4.5 and later, when the window
 * fills mid-reply) is one of them.
 */
const reportStopReason = (event: AnthropicClient.MessageStreamEvent): Effect.Effect<void> => {
  if (event.type !== "message_delta" || Predicate.isNull(event.delta.stop_reason)) {
    return Effect.void
  }
  return reportProviderStopReason(event.delta.stop_reason)
}

/**
 * Builds the AnthropicClient for one auth path. The request plan (effort and
 * thinking) and the path's payload rewrite are applied to the JSON body of
 * every outgoing request, so both `createMessage` and `createMessageStream`
 * send exactly what the plan says. The body is not decoded against the SDK's
 * request schema: that schema lags the API (it has no `thinking.display` and
 * no `xhigh`) and a decode would drop or reject what the API accepts. The
 * path's reply mapping wraps the SDK service.
 */
const anthropicClientLayer = <R>(
  { AnthropicClient }: AnthropicSdk,
  { plan, effortCarrier: carrier }: Pick<AnthropicRequest, "plan" | "effortCarrier">,
  path: ClientPath<R>,
  sdkLayer: SdkClientLayer,
): Layer.Layer<AnthropicClient.AnthropicClient, never, HttpClient.HttpClient | R> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const pathContext = yield* Effect.context<R>()
      const rewriteBody = HttpClient.mapRequestEffect(
        (request: HttpClientRequest.HttpClientRequest) =>
          Option.match(requestJsonObject(request), {
            onNone: () => Effect.succeed(request),
            onSome: (payload) =>
              path.payload(applyRequestPlan(payload, plan, carrier)).pipe(
                Effect.provideContext(pathContext),
                Effect.map((body) => {
                  let rewritten = HttpClientRequest.bodyJsonUnsafe(request, body)
                  if (bindsThinking(body)) rewritten = withBeta(rewritten, THINKING_BINDING_BETA)
                  if (carriesEffortMarker(body)) {
                    rewritten = withBeta(rewritten, MID_CONVERSATION_EFFORT_BETA)
                  }
                  return rewritten
                }),
              ),
          }),
      )
      const replies = Layer.effect(
        AnthropicClient.AnthropicClient,
        Effect.gen(function* () {
          const inner = yield* AnthropicClient.AnthropicClient
          return AnthropicClient.AnthropicClient.of({
            ...inner,
            createMessage: (request) =>
              path.message(inner.createMessage(request), requestToolIds(request.payload)),
            createMessageStream: (request) =>
              path
                .stream(inner.createMessageStream(request), requestToolIds(request.payload))
                .pipe(
                  Effect.map(
                    ([response, stream]) =>
                      [
                        response,
                        stream.pipe(Stream.tap(reportStopReason)),
                      ] satisfies CreateMessageStreamReply,
                  ),
                ),
          })
        }),
      )
      return replies.pipe(Layer.provide(sdkLayer(rewriteBody)))
    }),
  )

/**
 * The API-key path marks prompt-cache breakpoints and changes nothing else.
 * The Claude Code path marks its payload in `transformPayload`.
 */
const apiKeyClientPath = (cacheLifetimes: Option.Option<CacheLifetimes>): ClientPath<never> => ({
  payload: (payload) =>
    Effect.succeed(markRequestCache(payload, CachePrefixEnd.cases.System.make({}), cacheLifetimes)),
  message: (call) => call,
  stream: (call) => call,
})

/**
 * The Claude Code path: its keychain conventions on the payload, the tool
 * names restored on the reply, and a request that fails on its credential
 * keeps the credential's own message.
 */
const claudeCodeClientPath = (
  { Generated }: AnthropicSdk,
  creds: CredentialCache<ClaudeCredentials>,
  cacheLifetimes: Option.Option<CacheLifetimes>,
): ClientPath<KeychainTransformRequirements> => {
  const explain = explainCredentialFailure(creds)
  const decodeMessage = Schema.decodeUnknownSync(Generated.BetaMessage)
  return {
    payload: (payload) => transformPayload(payload, cacheLifetimes),
    message: (call, toolIds) =>
      explain(call).pipe(
        Effect.map(([body, response]) => {
          const b = decodeJsonRecord(body)
          const content = b["content"]
          if (isRecordArray(content)) {
            const transformed = {
              ...b,
              content: transformResponseContent(content, toolIds),
            }
            return [decodeMessage(transformed), response] satisfies CreateMessageReply
          }
          return [body, response] satisfies CreateMessageReply
        }),
      ),
    stream: (call, toolIds) =>
      explain(call).pipe(
        Effect.map(
          ([response, stream]) =>
            [
              response,
              stream.pipe(Stream.map(transformStreamEvent(toolIds))),
            ] satisfies CreateMessageStreamReply,
        ),
      ),
  }
}

// ── keychain transform ──────────────────────────────────────────────────────

/**
 * keychainTransformClient — `@effect/ai-anthropic` `transformClient`
 * callback.
 *
 * The SDK applies `transformClient` after its own baseline header pipeline
 * (`x-api-key`, `anthropic-version`, `accept: application/json`). This
 * middleware augments + overrides what OAuth needs:
 *
 * - Sets `authorization: Bearer <accessToken>` from the credential cache
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
 * Why a factory `(creds) => (client) => client`: the SDK's
 * `transformClient` signature is `(HttpClient) => HttpClient`, which
 * requires the returned client's requirement channel to be empty, so the
 * credential cache is a closure argument. Per-request semantics are
 * preserved because each call to `creds.getFresh` still consults the
 * live `Ref` cache.
 *
 * The middleware stack, layered outside-in via `pipe`:
 *   - mapRequestEffect (preprocess) — auth headers
 *   - 401 recovery (outer) — invalidate creds + retry once
 *
 * There is no 429/529/5xx or transport retry here. The SDK maps those to
 * retryable `AiError`s, and the agent loop owns that retry under the
 * driver's policy: it honors `retry-after` and reports each attempt.
 */

// ── Helpers ──

/** Build the OAuth header set for a request. */
const buildOauthHeaders = (
  req: HttpClientRequest.HttpClientRequest,
  accessToken: string,
  modelId: string,
  env: AnthropicKeychainEnv,
): Headers.Headers => {
  // Start from the SDK's existing headers (preserve `anthropic-version`
  // etc.) but drop `x-api-key` since OAuth uses Bearer.
  let headers = Headers.remove(req.headers, "x-api-key")

  const modelBetas = getModelBetas(modelId, Option.fromNullishOr(env.betaFlags))
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
 * Takes the credential cache as a closure argument: the SDK's
 * `transformClient` signature `(HttpClient) => HttpClient` requires the
 * returned client to have an empty requirement channel. Each request
 * invokes `creds.getFresh`, which consults the live `Ref` cache.
 */
export const buildKeychainTransformClient = (
  creds: CredentialCache<ClaudeCredentials>,
  env: AnthropicKeychainEnv,
): ((client: HttpClient.HttpClient) => HttpClient.HttpClient) =>
  authorizedClient(creds, (req, fresh) => {
    const modelId = requestModelId(req)
    return withHeaders(req, buildOauthHeaders(req, fresh.accessToken, modelId, env))
  })

// ── rate-limit reset ──

/** A limit's left count, and when it is full again (RFC 3339), as Anthropic's 429 headers name them. */
const LimitRemaining = Schema.OptionFromOptionalKey(Schema.FiniteFromString)
const LimitReset = Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString)

/** Anthropic's rate-limit headers, one pair per limit. */
const AnthropicRateLimitHeaders = Schema.Struct({
  "anthropic-ratelimit-requests-remaining": LimitRemaining,
  "anthropic-ratelimit-requests-reset": LimitReset,
  "anthropic-ratelimit-tokens-remaining": LimitRemaining,
  "anthropic-ratelimit-tokens-reset": LimitReset,
  "anthropic-ratelimit-input-tokens-remaining": LimitRemaining,
  "anthropic-ratelimit-input-tokens-reset": LimitReset,
  "anthropic-ratelimit-output-tokens-remaining": LimitRemaining,
  "anthropic-ratelimit-output-tokens-reset": LimitReset,
})

/** When the limits a rate-limited request's headers report spent are full again (`spentLimitsReset`). */
const spentHeadersReset = (response: FailureResponse): Option.Option<number> =>
  Option.flatMap(Schema.decodeOption(AnthropicRateLimitHeaders)(response.headers), (headers) => {
    const limit = (remaining: Option.Option<number>, reset: Option.Option<DateTime.Utc>) => ({
      remaining,
      resetAt: Option.map(reset, DateTime.toEpochMillis),
    })
    return spentLimitsReset([
      limit(
        headers["anthropic-ratelimit-requests-remaining"],
        headers["anthropic-ratelimit-requests-reset"],
      ),
      limit(
        headers["anthropic-ratelimit-tokens-remaining"],
        headers["anthropic-ratelimit-tokens-reset"],
      ),
      limit(
        headers["anthropic-ratelimit-input-tokens-remaining"],
        headers["anthropic-ratelimit-input-tokens-reset"],
      ),
      limit(
        headers["anthropic-ratelimit-output-tokens-remaining"],
        headers["anthropic-ratelimit-output-tokens-reset"],
      ),
    ])
  })

/**
 * When a retry of an Anthropic failure can succeed: the latest of the typed
 * retry-after and, for a rate-limited request only, the reset of the limits
 * its headers report spent. The Claude plan's own reset headers are not
 * read: no recorded plan 429 shows them yet.
 */
const anthropicRetryAt = (cause: unknown, nowMs: number): Option.Option<number> =>
  latestReset([
    retryAfterAt(cause, nowMs),
    Option.flatMap(rateLimitResponse(cause), spentHeadersReset),
  ])

// ── extension ───────────────────────────────────────────────────────────────

// Credential cache + refresh logic live in `makeAnthropicCredentialCache`.
// The OAuth path hands the cache to the keychain transform middleware,
// which reads it per request via `mapRequestEffect`.

/**
 * How a family thinks when a request does not say. From the model table at
 * platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
 * (read 2026-09-23):
 *   - `Off`: thinking stays off until the request sets `{type: "adaptive"}`.
 *   - `On`: thinking is on, and `{type: "disabled"}` turns it off.
 *   - `AlwaysOn`: thinking is on, and a request that disables it gets HTTP 400.
 *   - `BetweenTools`: thinking is on, and `{type: "between_tools"}` turns the
 *     up-front thinking off, at effort `low`, `medium` or `high` only (HTTP 400
 *     at `xhigh` or `max`). Claude Sonnet 5.5,
 *     platform.claude.com/docs/en/build-with-claude/effort ("Recommended
 *     effort levels for Claude Sonnet 5.5": "To turn off up-front thinking,
 *     send `thinking: {type: "between_tools"}` instead of `disabled`").
 *   - `Budget`: thinking stays off until the request sets `{type: "enabled",
 *     budget_tokens}`; the family has no adaptive thinking, and its effort
 *     does not turn thinking on (Claude Opus 4.5, platform.claude.com/docs/en/build-with-claude/extended-thinking).
 */
type ThinkingDefault = "Off" | "On" | "AlwaysOn" | "BetweenTools" | "Budget"

/**
 * The Claude families whose thinking default the table above names, first
 * match wins, by the lowercased id. models.dev lists each model's efforts,
 * budget and toggle, and whether it takes a `temperature`; it does not carry
 * the default, so this rule is all the Messages class keeps per family. A
 * family a row names thinks at a level, which an `Off` or `Budget` family
 * needs to reason: adaptively, showing its thinking (`THINKING_CONFIG`), or
 * a `Budget` family with its budget beside the effort. Opus 4.5 lists the
 * same controls (an effort list and a budget) as Opus 4.6, which takes
 * adaptive thinking, so the catalog alone cannot tell them apart.
 */
const THINKING_DEFAULTS: ReadonlyArray<{
  readonly pattern: RegExp
  readonly thinking: ThinkingDefault
}> = [
  { pattern: /(fable-5|mythos|opus-5-5)(-|$)/, thinking: "AlwaysOn" },
  { pattern: /sonnet-5-5(-|$)/, thinking: "BetweenTools" },
  // Opus 5 accepts `disabled` only at effort `high` or below; `none` names no effort.
  { pattern: /(opus-5|sonnet-5)(-|$)/, thinking: "On" },
  { pattern: /(opus-4-[78]|(opus|sonnet)-4-6)(-|$)/, thinking: "Off" },
  { pattern: /opus-4-5(-|$)/, thinking: "Budget" },
]

const thinkingDefault = (modelId: string): Option.Option<ThinkingDefault> =>
  Option.map(
    Option.fromUndefinedOr(
      THINKING_DEFAULTS.find((row) => row.pattern.test(modelId.toLowerCase())),
    ),
    (row) => row.thinking,
  )

/**
 * Where models.dev and gent disagree on an Anthropic model, gent's value,
 * with its receipt. models.dev lists 1M for Claude Sonnet 4.5, which has 200k
 * now that no beta widens it, and a request past the real window fails
 * before compaction would start.
 */
const ANTHROPIC_OVERRIDES: ReadonlyArray<CatalogOverride> = [
  {
    match: /^claude-sonnet-4-5(-|$)/,
    patch: (entry) =>
      Option.match(Option.fromUndefinedOr(entry.limit), {
        onNone: () => entry,
        onSome: (limit) => ({ ...entry, limit: { ...limit, context: 200_000 } }),
      }),
    receipt:
      "platform.claude.com/docs/en/build-with-claude/context-windows (Sonnet 4.5: 200k), read 2026-09-23",
  },
]

/**
 * What one model's requests carry for a reasoning hint. Every Messages path
 * applies it to the request body in `anthropicClientLayer`: the SDK config
 * type cannot name effort `xhigh` or `max`, and effort and thinking are
 * decided together.
 */
interface AnthropicRequestPlan {
  readonly effort: Option.Option<ReasoningEffort>
  readonly thinking: Option.Option<JsonRecord>
}

const PLAIN_REQUEST: AnthropicRequestPlan = { effort: Option.none(), thinking: Option.none() }

/**
 * The request plan for a catalog entry and a hint.
 *
 * - No hint: the model's own defaults. A family that thinks by default is
 *   sent `adaptive`, its own default, so that the thinking display applies.
 * - `none`: as little reasoning as the model allows. An always-on family
 *   runs at its lowest effort with the adaptive thinking its other levels
 *   send, so `/effort off` is an effort change and keeps the cache; a `BetweenTools` family (Claude Sonnet 5.5)
 *   sends `between_tools` at its lowest effort; a family on by default, or a
 *   model that lists a toggle, turns thinking off. The compaction summary asks for this under
 *   a 768-token cap, and thinking counts toward `max_tokens`, so a thinking
 *   summary can come back cut or empty.
 * - A level with an effort list: the lowest effort the model accepts at or
 *   above it, else its highest, with adaptive thinking for a family the
 *   default rule names. A `Budget` family (Claude Opus 4.5) has no adaptive
 *   thinking and its effort alone does not turn thinking on, so it gets
 *   thinking `enabled` with the budget beside the effort, as OpenCode sends
 *   it (`anthropicEffort`).
 * - A level with a thinking budget and no effort list: thinking `enabled`
 *   with the budget.
 * - A level with only a toggle (MiniMax M3, which thinks only when asked):
 *   adaptive thinking.
 */
const anthropicRequestPlan = (
  entry: CatalogModel,
  hints: Option.Option<ProviderHints>,
): AnthropicRequestPlan => {
  const rule = thinkingDefault(entry.id)
  const hint = reasoningHint(entry, hints)
  if (Option.isNone(hint)) {
    if (Option.exists(rule, (value) => value !== "Off" && value !== "Budget")) {
      return { effort: Option.none(), thinking: Option.some(THINKING_CONFIG.adaptive) }
    }
    return PLAIN_REQUEST
  }
  if (hint.value === "none") {
    // The thinking every other level sends: the change stays an effort
    // change, which the conversation can carry with the cache intact.
    if (Option.contains(rule, "AlwaysOn")) {
      return { effort: lowestEffort(entry), thinking: Option.some(THINKING_CONFIG.adaptive) }
    }
    if (Option.contains(rule, "BetweenTools")) {
      return {
        effort: lowestEffort(entry),
        thinking: Option.some(THINKING_CONFIG.betweenTools),
      }
    }
    if (Option.contains(rule, "On") || hasToggle(entry)) {
      return { effort: Option.none(), thinking: Option.some(THINKING_CONFIG.disabled) }
    }
    return PLAIN_REQUEST
  }
  const effort = effortFor(entry, hint.value)
  const budget = Option.map(thinkingBudget(entry, hint.value, hints), (tokens): JsonRecord => ({
    type: "enabled",
    budget_tokens: tokens,
  }))
  if (Option.isSome(effort)) {
    if (Option.contains(rule, "Budget")) return { effort, thinking: budget }
    return { effort, thinking: Option.map(rule, () => THINKING_CONFIG.adaptive) }
  }
  if (Option.isSome(budget)) return { effort: Option.none(), thinking: budget }
  if (hasToggle(entry))
    return { effort: Option.none(), thinking: Option.some({ type: "adaptive" }) }
  return PLAIN_REQUEST
}

/**
 * The effort levels a Messages request names for the entry
 * (`Model.efforts`): the effort each level's plan sends, and `none` where
 * the plan for `none` turns reasoning off instead of sending its lowest
 * effort (a family on by default, an `Off` or `Budget` family, a toggle) or
 * limits it to `between_tools` (Claude Sonnet 5.5). Empty without an effort
 * list: a level then picks a budget or a toggle.
 */
const messagesEfforts = (entry: CatalogModel): ReadonlyArray<ReasoningEffort> => {
  if (acceptedEfforts(entry).length === 0) return []
  const sent = ReasoningEffort.literals.map((level): ReasoningEffort => {
    const plan = anthropicRequestPlan(entry, Option.some({ reasoning: level }))
    if (Option.exists(plan.thinking, (thinking) => thinking === THINKING_CONFIG.betweenTools)) {
      return "none"
    }
    return Option.getOrElse(plan.effort, (): ReasoningEffort => "none")
  })
  return ReasoningEffort.literals.filter((level) => sent.includes(level))
}

type AnthropicConfig = Required<Parameters<typeof AnthropicLanguageModel.layer>[0]>["config"]

/** One model's requests: the SDK config, the plan the client layer applies, and the prompt-cache lifetimes its markers ask for. */
interface AnthropicRequest {
  /** The output cap, and `temperature` where the model takes one. */
  readonly config: AnthropicConfig
  readonly plan: AnthropicRequestPlan
  /** None when the hints carry no `cacheKey`: the request writes no cache. */
  readonly cacheLifetimes: Option.Option<CacheLifetimes>
  /** The effort changes the conversation carries as markers; none sends the plan's effort at the top level. */
  readonly effortCarrier: Option.Option<EffortCarrier>
}

/** Whether a request may carry effort markers: only the Claude API's own (`takesEffortMarkers`). */
type EffortMarkers = "claude-api" | "none"

/**
 * One model's requests. A `temperature` goes only to a model that takes one
 * (`temperature: false` in the catalog gets HTTP 400 on every request) and
 * only while the plan sends no thinking, which rejects it.
 */
const anthropicRequest = (
  entry: CatalogModel,
  hints: Option.Option<ProviderHints>,
  promptCacheTtl: PromptCacheTtl,
  markers: EffortMarkers,
): AnthropicRequest => {
  const plan = anthropicRequestPlan(entry, hints)
  let config: AnthropicConfig = {}
  const maxTokens = maxTokensOf(hints)
  if (Option.isSome(maxTokens)) config = { ...config, max_tokens: maxTokens.value }
  const temperature = hints.pipe(
    Option.filter(() => entry.temperature !== false && Option.isNone(plan.thinking)),
    Option.flatMap((value) => Option.fromNullishOr(value.temperature)),
  )
  if (Option.isSome(temperature)) config = { ...config, temperature: temperature.value }
  const child = Option.exists(hints, (value) => value.child === true)
  const lifetimes = cacheLifetimes(promptCacheTtl, child)
  return {
    config,
    plan,
    cacheLifetimes: Option.liftPredicate(lifetimes, () => writesPromptCache(hints)),
    effortCarrier: messagesEffortCarrier(entry, hints, plan, markers),
  }
}

/**
 * The effort a Messages request applies: the hint's level clamped to the
 * model's levels; with no level, the model's default when it reasons.
 */
const messagesEffort = (
  entry: CatalogModel,
  hints: Option.Option<ProviderHints>,
): Option.Option<RunEffort> =>
  Option.match(reasoningHint(entry, hints), {
    onNone: () =>
      Option.some<RunEffort>("default").pipe(Option.filter(() => modelReasons(entry, hints))),
    onSome: (level): Option.Option<RunEffort> => clampEffort(messagesEfforts(entry), level),
  })

/**
 * The effort changes a Messages request carries, for a model the Claude API
 * takes markers on. Every effort in the history must plan the thinking the
 * request sends and name itself as the effort: a change that turns thinking
 * off or to `between_tools` is a top-level change, and the request is plain.
 * The efforts are the receipts' (`messagesEfforts` clamps the level as core
 * does), so the current one is clamped the same way. A request with no level
 * to a model that reasons runs at the model's default (`markerDefaultEffort`),
 * and its plan names no effort.
 */
const messagesEffortCarrier = (
  entry: CatalogModel,
  hints: Option.Option<ProviderHints>,
  plan: AnthropicRequestPlan,
  markers: EffortMarkers,
): Option.Option<EffortCarrier> => {
  if (markers === "none" || !takesEffortMarkers(entry.id)) return Option.none()
  const current = messagesEffort(entry, hints)
  return effortCarrier(hints, current, markerDefaultEffort(entry.id), (effort) => {
    if (effort === "default") {
      const planned = anthropicRequestPlan(entry, Option.none())
      return (
        Option.isNone(planned.effort) &&
        Option.getOrUndefined(planned.thinking) === Option.getOrUndefined(plan.thinking)
      )
    }
    const planned = anthropicRequestPlan(entry, Option.some({ reasoning: effort }))
    return (
      Option.contains(planned.effort, effort) &&
      Option.getOrUndefined(planned.thinking) === Option.getOrUndefined(plan.thinking)
    )
  })
}

/**
 * The effort a model that takes markers runs at when the request names none:
 * `medium` on Claude Opus 5.5, `high` on Claude Opus 5, Claude Sonnet 5.5,
 * Claude Fable 5.1 and Claude Mythos 5.1 (claude-api skill `shared/models.md`
 * and the SDK READMEs: "the default is `medium` on this model, where Claude
 * Opus 5 defaults to `high`"; the effort doc's default for the others). None
 * for a later version, whose default no receipt names yet: its runs at the
 * default read as unknown.
 */
const markerDefaultEffort = (modelId: string): Option.Option<ReasoningEffort> => {
  const match = /(opus|sonnet|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=-|$)/.exec(modelId.toLowerCase())
  if (Predicate.isNull(match)) return Option.none()
  const [, family = "", major = "0", minor = "0"] = match
  const version = Number(major) * 100 + Number(minor)
  return Option.map(
    Option.fromUndefinedOr(
      MARKER_DEFAULT_EFFORTS.find((row) => row.family === family && row.version === version),
    ),
    (row) => row.effort,
  )
}

/** The default effort of each model version that takes markers, as `major * 100 + minor`. */
const MARKER_DEFAULT_EFFORTS: ReadonlyArray<{
  readonly family: string
  readonly version: number
  readonly effort: ReasoningEffort
}> = [
  { family: "opus", version: 500, effort: "high" },
  { family: "opus", version: 505, effort: "medium" },
  { family: "sonnet", version: 505, effort: "high" },
  { family: "fable", version: 501, effort: "high" },
  { family: "mythos", version: 501, effort: "high" },
]

/**
 * Whether the Claude API takes an effort change inside the conversation for
 * the model: Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5, Claude
 * Opus 5 and Claude Sonnet 5.5, and the later versions of each family
 * (platform.claude.com/docs/en/build-with-claude/effort, "Change effort
 * mid-conversation", read 2026-10-04; opencode
 * `packages/ai/src/protocols/anthropic-messages.ts`, Opus 5 and later,
 * Fable/Mythos 5.1 and later). Any other model returns a 400 for the marker.
 * The version is `<family>-<major>[-<minor>]`; a date suffix is not a minor.
 */
const takesEffortMarkers = (modelId: string): boolean => {
  const match = /(opus|sonnet|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=-|$)/.exec(modelId.toLowerCase())
  if (Predicate.isNull(match)) return false
  const [, family = "", major = "0", minor = "0"] = match
  const row = EFFORT_MARKER_FIRST_VERSIONS.find((value) => value.family === family)
  if (Predicate.isUndefined(row)) return false
  return Number(major) * 100 + Number(minor) >= row.first
}

/** The first version of each family that takes effort markers, as `major * 100 + minor`. */
const EFFORT_MARKER_FIRST_VERSIONS = [
  { family: "opus", first: 500 },
  { family: "fable", first: 501 },
  { family: "mythos", first: 501 },
  { family: "sonnet", first: 505 },
] as const

/**
 * The thinking object for each plan value. Adaptive thinking asks for `display:
 * "summarized"`: platform.claude.com/docs/en/build-with-claude/thinking
 * (read 2026-09-23) says `"omitted"` "is the default on Claude Fable 5.1,
 * Claude Mythos 5.1, Claude Fable 5, Claude Mythos 5, Claude Opus 5.5, Claude
 * Opus 5, Claude Sonnet 5, Claude Opus 4.8, Claude Opus 4.7", which streams
 * thinking blocks with empty text, and that "`display` works in both modes".
 * `"summarized"` is already the default on the 4.6 models, so it changes
 * nothing there. `display` "is invalid with `thinking.type: "disabled"`".
 *
 * Adaptive thinking also sets `block_binding: { prefix_mismatch_behavior:
 * "drop_block" }`. platform.claude.com/docs/en/build-with-claude/preserved-thinking
 * (read 2026-09-23): on Claude Fable 5.1 and Claude Opus 5.5 a replayed thinking
 * block "stays valid only while the top-level `system` prompt, the `tools`, and
 * the messages before it are unchanged", and the default for a block that fails
 * is a 400. The loop changes that prefix on its own: the Date line on a resumed
 * session, a compacted window, a tool list that changes. With `drop_block` the
 * API drops the failing blocks and answers, so a replay never turns a working
 * request into a 400. "Models that don't run the prefix check accept the object
 * and report only model-check drops, so one request body works across models."
 * The field needs the `thinking-binding-controls-2026-08-01` beta.
 */
const THINKING_CONFIG = {
  adaptive: {
    type: "adaptive",
    display: "summarized",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  },
  disabled: { type: "disabled" },
  betweenTools: { type: "between_tools" },
} satisfies Record<"adaptive" | "disabled" | "betweenTools", JsonRecord>

/** The beta that `thinking.block_binding` requires; sending the field without it is a 400. */
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01"

/** Whether the payload's thinking object carries `block_binding`. */
const bindsThinking = (payload: JsonRecord): boolean => {
  const thinking = payload["thinking"]
  return isRecord(thinking) && "block_binding" in thinking
}

/** The request with `beta` added to its `anthropic-beta` list, other betas kept. */
const withBeta = (
  request: HttpClientRequest.HttpClientRequest,
  beta: string,
): HttpClientRequest.HttpClientRequest => {
  const current = Option.getOrElse(
    Option.fromUndefinedOr(request.headers["anthropic-beta"]),
    () => "",
  )
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (current.includes(beta)) return request
  return HttpClientRequest.setHeader(request, "anthropic-beta", [...current, beta].join(","))
}

/**
 * The payload with the plan's effort and thinking; any `output_config` the
 * SDK set is kept. With effort changes to carry, and a conversation they fit,
 * the top level names the pinned effort and each change is a marker
 * (`withEffortMarkers`).
 */
const applyRequestPlan = (
  payload: JsonRecord,
  plan: AnthropicRequestPlan,
  carrier: Option.Option<EffortCarrier>,
): JsonRecord => {
  let result = payload
  if (Option.isSome(plan.thinking)) result = { ...result, thinking: plan.thinking.value }
  let effort = plan.effort
  const messages = result["messages"]
  if (Option.isSome(carrier) && isRecordArray(messages)) {
    const marked = withEffortMarkers(messages, carrier.value)
    if (Option.isSome(marked)) {
      result = { ...result, messages: marked.value }
      // A first run at the model's default named no effort: neither does this request.
      const pinned = carrier.value.pinned
      effort = Option.none()
      if (pinned !== "default") effort = Option.some(pinned)
    }
  }
  if (Option.isSome(effort)) {
    const current = result["output_config"]
    let outputConfig: JsonRecord = {}
    if (isRecord(current)) outputConfig = current
    result = { ...result, output_config: { ...outputConfig, effort: effort.value } }
  }
  return result
}

/**
 * The beta an effort marker needs (platform.claude.com/docs/en/build-with-claude/effort,
 * "Change effort mid-conversation"). A request carries it only with a marker.
 */
const MID_CONVERSATION_EFFORT_BETA = "mid-conversation-output-config-2026-07-01"

/**
 * The Messages effort marker: a system message with no content and the
 * effort the conversation runs at from the next user turn.
 */
const effortMarker = (effort: ReasoningEffort): JsonRecord => ({
  role: "system",
  content: [],
  output_config: { effort },
})

/** True for an effort marker (`effortMarker`). */
const isEffortMarker = (message: JsonRecord): boolean =>
  message["role"] === "system" && "output_config" in message

/** True for a user message that answers a tool call. */
const carriesToolResult = (message: JsonRecord): boolean => {
  const content = message["content"]
  return isRecordArray(content) && content.some((block) => block["type"] === "tool_result")
}

/**
 * The messages with a marker at each effort change. A marker takes effect
 * from the next user turn (platform.claude.com/docs/en/build-with-claude/effort,
 * read 2026-10-04), so a change at run `k` goes before the user turn after
 * run `k - 1`; a user turn that answers a tool call keeps its place right
 * after the call, so the marker goes after it, and it takes effect at run `k`
 * only when another user turn follows before that run. The place depends only
 * on the messages up to that turn, so the next request has the marker at the
 * same place. None, so the request is plain and its top level names the
 * reply's effort, when the assistant turns do not match the receipts' runs
 * (the SDK merged or dropped one), or a change would take effect only after
 * its run: a change right after a tool result, or a prompt the SDK merged into
 * the tool result before it.
 */
const withEffortMarkers = (
  messages: ReadonlyArray<JsonRecord>,
  carrier: EffortCarrier,
): Option.Option<ReadonlyArray<JsonRecord>> => {
  const assistants = messages.flatMap((message, index) => {
    if (message["role"] === "assistant") return [index]
    return []
  })
  if (assistants.length !== carrier.runs) return Option.none()
  const places = new Map<number, ReasoningEffort>()
  for (const change of carrier.changes) {
    const previous = assistants[change.run - 1]
    if (Predicate.isUndefined(previous)) return Option.none()
    const turn = messages[previous + 1]
    if (Predicate.isUndefined(turn)) return Option.none()
    let place = previous + 1
    if (carriesToolResult(turn)) place = previous + 2
    // The run starts at its assistant message, or the reply at the end.
    const run = Option.getOrElse(
      Option.fromUndefinedOr(assistants[change.run]),
      () => messages.length,
    )
    if (place >= run) return Option.none()
    places.set(place, change.effort)
  }
  const result: Array<JsonRecord> = []
  for (const [index, message] of messages.entries()) {
    const effort = places.get(index)
    if (Predicate.isNotUndefined(effort)) result.push(effortMarker(effort))
    result.push(message)
  }
  return Option.some(result)
}

/** Whether the payload carries an effort marker. */
const carriesEffortMarker = (payload: JsonRecord): boolean => {
  const messages = payload["messages"]
  return isRecordArray(messages) && messages.some(isEffortMarker)
}

// ── Layer construction helpers ──

/**
 * API-key path: plain `AnthropicClient.layer` over `ModelHttpClient`.
 * No keychain wrapper — `buildKeychainTransformClient` injects Claude Code OAuth
 * billing-header system blocks + identity prefix, which API-key users
 * are not on the hook for.
 */
const makeApiKeyAnthropicLayer = (
  sdk: AnthropicSdk,
  modelName: string,
  request: AnthropicRequest,
  endpoint: ApiEndpoint,
) => {
  const { AnthropicClient, AnthropicLanguageModel } = sdk
  // The SDK adds `/v1/messages` to its base URL itself; models.dev names the `/v1` root.
  const apiUrl = Option.map(endpoint.baseUrl, (url) => url.replace(/\/v1\/?$/, ""))
  const clientLayer = anthropicClientLayer(
    sdk,
    request,
    apiKeyClientPath(request.cacheLifetimes),
    (rewriteBody) =>
      AnthropicClient.layer({
        apiKey: sdkApiKey(endpoint.apiKey),
        apiUrl: Option.getOrUndefined(apiUrl),
        transformClient: (client) =>
          Option.match(endpoint.transformClient, {
            onNone: () => rewriteBody(client),
            onSome: (transform) => transform(rewriteBody(client)),
          }),
      }),
  ).pipe(Layer.provide(ModelHttpClient))
  return AnthropicLanguageModel.layer({ model: modelName, config: request.config }).pipe(
    Layer.provide(clientLayer),
  )
}

/**
 * OAuth path: builds `AnthropicClient.layer` with `transformClient` set
 * to the keychain transform middleware (auth headers, 401 recovery).
 *
 * The credential cell is allocated once in the extension setup. A cell
 * allocated per layer build would reset it and kill credential reuse.
 *
 * No `apiKey` is passed — the SDK's apiKey is optional and skips
 * `x-api-key` injection when absent (verified at
 * `~/.cache/repo/effect-ts/effect-smol/packages/ai/anthropic/src/AnthropicClient.ts:220`).
 * Avoids a brittle "scrub-the-placeholder" coupling between SDK and
 * middleware ordering.
 */
const makeOauthAnthropicLayer = (
  sdk: AnthropicSdk,
  modelName: string,
  request: AnthropicRequest,
  creds: CredentialCache<ClaudeCredentials>,
  services: AnthropicDriverServices,
) => {
  const { AnthropicClient, AnthropicLanguageModel } = sdk
  const keychain = buildKeychainTransformClient(creds, Context.get(services, AnthropicPlatform).env)
  const wrappedClient = anthropicClientLayer(
    sdk,
    request,
    claudeCodeClientPath(sdk, creds, request.cacheLifetimes),
    (rewriteBody) =>
      AnthropicClient.layer({ transformClient: (client) => keychain(rewriteBody(client)) }),
  ).pipe(Layer.provide(ModelHttpClient), Layer.provide(Layer.succeedContext(services)))
  return AnthropicLanguageModel.layer({ model: modelName, config: request.config }).pipe(
    Layer.provide(wrappedClient),
  )
}

/**
 * The cache lifetime the Messages class asks for on a provider other than
 * Anthropic: the `ephemeral` default, 5 minutes, which every Messages
 * upstream takes. The Anthropic driver picks its own (`PromptCacheTtl`).
 */
const MESSAGES_PROMPT_CACHE_TTL: PromptCacheTtl = "5m"

/**
 * The Anthropic Messages API, for any provider whose models.dev entry names
 * `@ai-sdk/anthropic` (the OpenCode gateways' Claude, MiniMax and Qwen
 * models). The request plan and the cache markers are the Anthropic
 * driver's own.
 */
export const MESSAGES_CLASS: ApiClassContribution = {
  id: "anthropic-messages",
  npm: ["@ai-sdk/anthropic"],
  protocols: [],
  promptCacheTtl: Option.some(PROMPT_CACHE_LIFETIME[MESSAGES_PROMPT_CACHE_TTL]),
  efforts: messagesEfforts,
  // An image costs width x height / 750 tokens. Claude 4.7 and later keep high resolution
  // (3,888 tokens for 2000x1500) where older models scale down to about 1,600, so no cap
  // applies: every model is bounded, and an older one is overcounted (compaction comes early).
  imageCost: () => ({ _tag: "Pixels", pixelsPerToken: 750 }),
  resolveModel: (request) =>
    Effect.map(loadAnthropicSdk, (sdk) =>
      AiModel.make(
        request.providerId,
        request.model.id,
        makeApiKeyAnthropicLayer(
          sdk,
          request.model.id,
          // A gateway names no receipt that it passes the effort marker on.
          anthropicRequest(request.model, request.hints, MESSAGES_PROMPT_CACHE_TTL, "none"),
          request,
        ),
      ),
    ),
}

/**
 * Build the model-driver contribution over a credential cell the caller
 * allocated once: every `resolveModel` call shares it, so a credential is
 * reused (a fresh cell per `resolveModel` would lose it).
 */
export const buildAnthropicModelDriver = (
  credentialCellRef: CredentialCacheCellRef<ClaudeCredentials>,
  envApiKey: Option.Option<string>,
  services: AnthropicDriverServices,
  promptCacheTtl: PromptCacheTtl,
): ModelDriverContribution & Required<Pick<ModelDriverContribution, "resolveModel">> => {
  const cellFor = credentialCells(credentialCellRef)
  return {
    id: "anthropic",
    name: "Anthropic",
    envCredential: "ANTHROPIC_API_KEY",
    overrides: ANTHROPIC_OVERRIDES,
    // The lifetimes the markers ask for, a root's and a child's, and the write price; see `PromptCacheTtl`.
    listModels: (catalog) =>
      Effect.succeed(
        catalogModels(catalog, "anthropic", PROMPT_CACHE_LIFETIME[promptCacheTtl], MESSAGES_CLASS),
      ).pipe(
        Effect.map(withChildPromptCacheLifetime(promptCacheTtl)),
        Effect.map(withPromptCacheWritePrice(promptCacheTtl)),
      ),
    cacheWritesByLifetime: anthropicCacheWritesByLifetime,
    // A model the Claude API takes effort markers on carries a change of level
    // inside the conversation, where every run of the history plans the same thinking.
    // The request must keep the previous one's prefix: the same top-level
    // effort, and the same markers up to the reply it asks for.
    carriesEffort: (modelName, hints, catalog) => {
      const entry = adapterEntry(Option.fromUndefinedOr(catalog), "anthropic", modelName)
      const carrier = (planned: Option.Option<ProviderHints>) =>
        messagesEffortCarrier(entry, planned, anthropicRequestPlan(entry, planned), "claude-api")
      return keepsEffortPrefix(hints, (planned) => ({
        current: messagesEffort(entry, planned),
        carrier: carrier(planned),
      }))
    },
    retry: {
      ...DEFAULT_RETRY_POLICY,
      transientStreamEvent: MessagesTransientStreamEvent,
      retryAt: anthropicRetryAt,
    },
    resolveModel: (modelName, authInfo, hints, catalog) =>
      Effect.gen(function* () {
        const auth = Option.fromNullishOr(authInfo)
        const entry = adapterEntry(Option.fromUndefinedOr(catalog), "anthropic", modelName)
        const request = anthropicRequest(
          entry,
          Option.fromNullishOr(hints),
          promptCacheTtl,
          "claude-api",
        )

        // Precedence, the same as OpenAI: stored Claude Code sign-in, then
        // stored API key, then ANTHROPIC_API_KEY. A user who chooses Claude
        // Code in /auth is not billed on a shell API key.
        if (Option.isSome(auth) && auth.value._tag === "Oauth") {
          // The credential cache is built over the extension-closure-owned
          // cell, so credential reuse survives. The credentials are checked before the
          // layer exists, so an expired sign-in fails with its own message.
          const slot = auth.value.slot ?? DEFAULT_CREDENTIAL_SLOT
          let cacheEffect = buildLiveCredentialCache(cellFor(slot), services)
          if (slot !== DEFAULT_CREDENTIAL_SLOT) {
            cacheEffect = buildNamedCredentialCache(cellFor(slot), auth.value.update, services)
          }
          const creds = yield* cacheEffect
          yield* checkCredentials(creds)
          return AiModel.make(
            "anthropic",
            modelName,
            makeOauthAnthropicLayer(yield* loadAnthropicSdk, modelName, request, creds, services),
          )
        }

        const apiKey = apiKeyFrom(auth, envApiKey)
        if (Option.isSome(apiKey)) {
          return AiModel.make(
            "anthropic",
            modelName,
            makeApiKeyAnthropicLayer(yield* loadAnthropicSdk, modelName, request, {
              apiKey,
              baseUrl: Option.none(),
              transformClient: Option.none(),
            }),
          )
        }

        // Fail closed: no stored sign-in, no stored API key, no env var.
        return yield* new ProviderAuthError({
          message:
            "Anthropic credentials unavailable: no Claude Code OAuth, stored API key, or ANTHROPIC_API_KEY env var",
        })
      }),
    auth: {
      methods: [
        AuthMethod.make({ type: "oauth", label: "Claude Code", credentialTarget: "default" }),
        AuthMethod.make({ type: "api", label: "Manually enter API key" }),
        AuthMethod.make({
          type: "oauth",
          label: "Claude Code directory import",
          credentialTarget: "named",
          prompts: [{ key: "directory", label: "Absolute Claude Code directory" }],
        }),
      ],
      authorize: (ctx) =>
        Effect.gen(function* () {
          const slot = ctx.slot ?? DEFAULT_CREDENTIAL_SLOT
          if (ctx.methodIndex === 2) {
            if (slot === DEFAULT_CREDENTIAL_SLOT)
              return yield* new ProviderAuthError({
                message: "Directory import needs a named credential slot",
              })
            const directory = ctx.inputs?.["directory"]
            if (Predicate.isUndefined(directory))
              return yield* new ProviderAuthError({
                message: "Claude Code import needs an absolute directory",
              })
            const creds = yield* readImportedCredentials(directory).pipe(
              Effect.provideContext(services),
            )
            if (!freshEnoughAt(creds.expiresAt, yield* Clock.currentTimeMillis))
              return yield* new ProviderAuthError({
                message: "Claude Code import source expired; sign in there again",
              })
            yield* replaceHeldCredential(ClaudeCredentials, cellFor(slot), creds, (onPersisted) =>
              ctx.persist(
                {
                  type: "oauth",
                  access: creds.accessToken,
                  refresh: creds.refreshToken,
                  expires: creds.expiresAt,
                },
                onPersisted,
              ),
            )
            return Option.some({
              url: "",
              method: "done" as const,
              instructions:
                "Imported once into Gent. Later Claude Code rotation may require reimport.",
            })
          }
          if (ctx.methodIndex !== 0) return Option.none()
          if (slot !== DEFAULT_CREDENTIAL_SLOT)
            return yield* new ProviderAuthError({
              message: "Named Claude Code credentials require directory import",
            })
          // The cell owns sign-in and refresh together. A spent token's rotation
          // reaches the cell before cancellation or a persistence failure surfaces.
          return yield* Effect.uninterruptibleMask((restore) =>
            SynchronizedRef.modifyEffect(credentialCellRef, () =>
              Effect.gen(function* () {
                let creds = yield* restore(readClaudeCodeCredentials)
                const now = yield* Clock.currentTimeMillis
                if (!freshEnoughAt(creds.expiresAt, now)) {
                  creds = yield* refreshClaudeCodeCredentials(Option.none()).pipe(
                    Effect.mapError((cause) => {
                      if (cause._tag === "ProviderAuthError") return cause
                      return new ProviderAuthError({ message: cause.message, cause })
                    }),
                  )
                }
                const persisted = yield* Effect.exit(
                  ctx
                    .persist({
                      type: "oauth",
                      access: creds.accessToken,
                      refresh: creds.refreshToken,
                      expires: creds.expiresAt,
                    })
                    .pipe(
                      Effect.timeoutOrElse({
                        duration: Duration.seconds(5),
                        orElse: () =>
                          new ProviderAuthError({
                            message: "Anthropic auth persistence timed out",
                          }),
                      }),
                    ),
                )
                const at = yield* Clock.currentTimeMillis
                return [
                  persisted.pipe(
                    Effect.as(
                      Option.some({
                        url: "",
                        method: "done",
                      } satisfies ProviderAuthorizationResult),
                    ),
                  ),
                  CredentialCacheCell(ClaudeCredentials).cases.Durable.make({
                    creds,
                    at,
                    invalidated: false,
                  }),
                ] as const
              }),
            ),
          ).pipe(Effect.flatten)
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
          Effect.provideContext(services),
        ),
    },
  }
}

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
    // The host's platform, not one of the driver's own: a shipped provider
    // is never more privileged than a user extension.
    const services: AnthropicDriverServices = Context.make(
      FileSystem.FileSystem,
      yield* FileSystem.FileSystem,
    ).pipe(
      Context.add(Path.Path, yield* Path.Path),
      Context.add(Crypto.Crypto, yield* Crypto.Crypto),
      Context.add(
        ChildProcessSpawner.ChildProcessSpawner,
        yield* ChildProcessSpawner.ChildProcessSpawner,
      ),
      Context.add(AnthropicPlatform, AnthropicPlatform.fromSetup(ctx, env)),
    )

    const http = yield* Effect.serviceOption(HttpClient.HttpClient)
    const driverServices = Option.match(http, {
      onNone: () => services,
      onSome: (client) => Context.add(services, HttpClient.HttpClient, client),
    })

    // One credential cell per extension instance, allocated at setup, so it
    // survives across `resolveModel` calls until the runtime tears the
    // extension down.
    const credentialCellRef =
      yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)

    yield* ctx.register(
      "modelDriver",
      buildAnthropicModelDriver(
        credentialCellRef,
        envApiKey,
        driverServices,
        yield* readPromptCacheTtl,
      ),
    )
    yield* ctx.register("apiClass", MESSAGES_CLASS)
  }),
})
