import {
  Cause,
  Clock,
  Context,
  Crypto,
  Duration,
  Effect,
  Encoding,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Redacted,
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
  Model,
  type ModelDriverContribution,
  ProviderAuthError,
  type ProviderAuthorizationResult,
  type ProviderHints,
  reportProviderStopReason,
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
  effortAtOrAbove,
  EMPTY_CREDENTIAL_CELL,
  explainCredentialFailure,
  authorizedClient,
  freshEnoughAt,
  isHostContextUpdateText,
  isTransientTokenStatus,
  makeCredentialCache,
  postOAuthForm,
  apiKeyFrom,
  readOptionalEnv,
  withHeaders,
} from "./providers.js"
import { ChildProcessSpawner } from "effect/unstable/process"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { AnthropicClient, AnthropicLanguageModel, Generated } from "@effect/ai-anthropic"
import { type AiError, Model as AiModel } from "effect/unstable/ai"

// Test seam: only tests read these exports. The model table and its lookups
// (MODEL_CONFIG, getModelOverride, getModelBetas), the billing header (SYSTEM_IDENTITY_PREFIX,
// extractFirstUserMessageText, computeCch, computeVersionSuffix,
// buildBillingHeaderValue), the wire transforms (transformPayload, transformResponseContent, transformStreamEvent)
// and the credential parsers (ClaudeCredentials,
// updateCredentialBlob, parseOAuthResponse) are pure functions with unit tests.
// AnthropicKeychainEnv, AnthropicPlatform, AnthropicCredentialIO,
// makeAnthropicCredentialCache and buildAnthropicModelDriver let a test run the
// keychain, the credential cache and the driver against fake I/O.

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
export const MODEL_CONFIG: ModelConfig = {
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
export const getModelOverride = (modelId: string): Option.Option<ModelOverride> => {
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
    return yield* compareAndWrite(raw, creds, base, (blob) =>
      fs.writeFileString(credentialsFile, blob).pipe(
        // chmod 0600 after write so the credentials file is not
        // world-readable on first creation.
        Effect.andThen(fs.chmod(credentialsFile, 0o600)),
        Effect.mapError(mapFsError),
      ),
    )
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
      const refreshed = yield* Effect.exit(refreshViaOAuth(sent.refreshToken))
      if (Exit.isSuccess(refreshed)) {
        // Best-effort write-back so subsequent processes pick up the
        // new token. A failure here doesn't lose the refresh — the
        // caller has it in memory.
        const base: RefreshBase = { read, sent }
        const outcome = yield* writeBackCredentials(refreshed.value, base).pipe(
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

    const { thirdPartyBlocks } = partitionSystemBlocks(result["system"])
    let messagesAfterRelocate: ReadonlyArray<JsonRecord> = []
    if (isRecordArray(result["messages"])) {
      messagesAfterRelocate = relocateThirdPartyIntoFirstUser(thirdPartyBlocks, result["messages"])
    }
    result["messages"] = messagesAfterRelocate
    result["system"] = yield* buildSystemArray(messagesAfterRelocate)

    return markCacheBreakpoints(result, "first-user")
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
 *      Claude Code path the system prompt's block in the first user
 *      message (it moves there, before the user's own text, and the
 *      billing and identity blocks take no marker). A new session and
 *      every sibling child read the prompt back from this entry;
 *   2. the last cacheable block of the last conversation message, so each
 *      step reads the previous step's conversation back from the cache. A
 *      host context update after it (a later system message, which the SDK
 *      sends as a `<host-context-update>` user message: the runtime's turn
 *      notices) takes no marker. It changes from turn to turn, so a marker
 *      on it would write an entry no later request reads, and the next step
 *      would find no entry at the conversation's end;
 *   3. on the API-key path, the end of the shared part of the system prompt:
 *      the runtime sends the prompt as two system blocks, the part a session
 *      shares with its children and then the agent's own part (the children
 *      guidance, the host tool list). A fresh child's first request reads the
 *      shared part back from its parent's entry. The marker goes only where
 *      the shared text reaches `SHARED_PREFIX_MIN_CHARS`: a shorter prefix is
 *      below the minimum cacheable length, and the marker would spend a slot
 *      for nothing. The Claude Code path joins the blocks into one relocated
 *      block, so it has no such point.
 *
 * The tool list takes no marker of its own: it renders first, so the
 * system prompt's marker caches it, and alone it is below the minimum
 * cacheable length (one `cell` tool, about 100 tokens).
 *
 * Markers already on the payload count toward the limit. A marker does
 * not change the cached bytes, so the tail marker moves forward each
 * step, which is the documented multi-turn pattern.
 */
type CachePrefixEnd = "system" | "first-user"

const CACHE_BREAKPOINT_LIMIT = 4
/**
 * 1,024 tokens at about 4 characters a token: the minimum cacheable prefix of
 * Sonnet 5 and Opus 4.8 (512 on Opus 5, up to 4,096 on older models). Counted
 * on the system text alone, the tools on top only lengthen the prefix.
 */
const SHARED_PREFIX_MIN_CHARS = 4_096
const EPHEMERAL_CACHE: JsonRecord = { type: "ephemeral" }
/** Content block types that take `cache_control`. Thinking blocks and empty text do not. */
const CACHEABLE_BLOCK_TYPES: ReadonlySet<unknown> = new Set([
  "text",
  "image",
  "document",
  "search_result",
  "tool_use",
  "tool_result",
])

const hasCacheMarker = (block: JsonRecord): boolean => isRecord(block["cache_control"])

/** A user message the SDK built from a later system message, not from the conversation. */
const isHostContextUpdate = (message: JsonRecord): boolean => {
  const content = message["content"]
  if (message["role"] !== "user" || !isRecordArray(content) || content.length === 0) return false
  return content.every(
    (block) => block["type"] === "text" && isHostContextUpdateText(block["text"]),
  )
}

const isCacheableBlock = (block: JsonRecord): boolean =>
  CACHEABLE_BLOCK_TYPES.has(block["type"]) && !(block["type"] === "text" && block["text"] === "")

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
): Option.Option<ReadonlyArray<JsonRecord>> =>
  Option.fromUndefinedOr(blocks[index]).pipe(
    Option.filter((block) => !hasCacheMarker(block)),
    Option.map((block) => {
      const next = blocks.slice()
      next[index] = { ...block, cache_control: EPHEMERAL_CACHE }
      return next
    }),
  )

const markLastCacheable = (blocks: ReadonlyArray<JsonRecord>) =>
  markBlockAt(blocks, blocks.findLastIndex(isCacheableBlock))

/**
 * The block that ends the system prompt in a Claude Code request: the first
 * text after any leading tool results in the first user message, where
 * `relocateThirdPartyIntoFirstUser` puts it.
 */
const systemPromptBlockIndex = (content: ReadonlyArray<JsonRecord>): number =>
  content.findIndex((block) => block["type"] !== "tool_result" && isCacheableBlock(block))

/**
 * The system blocks with the end of the shared part marked: the cacheable
 * block before the last one, when the text through it is long enough to cache.
 */
const markSharedSystemEnd = (
  system: ReadonlyArray<JsonRecord>,
): Option.Option<ReadonlyArray<JsonRecord>> => {
  const last = system.findLastIndex(isCacheableBlock)
  const shared = system.slice(0, Math.max(last, 0)).findLastIndex(isCacheableBlock)
  if (shared < 0) return Option.none()
  let chars = 0
  for (const block of system.slice(0, shared + 1)) {
    const text = block["text"]
    if (Predicate.isString(text)) chars += text.length
  }
  if (chars < SHARED_PREFIX_MIN_CHARS) return Option.none()
  return markBlockAt(system, shared)
}

/**
 * The payload with `cache_control` at the end of the system prompt, on the
 * conversation tail, and at the end of the system prompt's shared part.
 */
const markCacheBreakpoints = (payload: JsonRecord, prefixEnd: CachePrefixEnd): JsonRecord => {
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

  if (prefixEnd === "system") {
    if (isRecordArray(payload["system"])) {
      spend(markLastCacheable(payload["system"]), (system) => {
        result["system"] = system
      })
    }
  } else {
    markMessage(
      messages.findIndex((message) => message["role"] === "user"),
      (content) => markBlockAt(content, systemPromptBlockIndex(content)),
    )
  }
  markMessage(
    messages.findLastIndex((message) => !isHostContextUpdate(message)),
    markLastCacheable,
  )
  const system = result["system"]
  if (prefixEnd === "system" && isRecordArray(system)) {
    spend(markSharedSystemEnd(system), (marked) => {
      result["system"] = marked
    })
  }
  if (isRecordArray(payload["messages"])) result["messages"] = messages
  return result
}

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
    // content_block_start has type: "content_block_start" and content_block with the block data
    const e = Schema.decodeSync(JsonRecordSchema)(event)
    if (e["type"] !== "content_block_start") return event
    const rawBlock = e["content_block"]
    if (!isRecord(rawBlock)) return event
    const block = rawBlock
    if (block["type"] === "tool_use" && Predicate.isString(block["name"])) {
      return decodeMessageStreamEvent({
        ...event,
        content_block: { ...block, name: unprefixName(toolIds, block["name"]) },
      })
    }
    return event
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

const decodeJsonBody = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRecordSchema))

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
  plan: AnthropicRequestPlan,
  path: ClientPath<R>,
  sdkLayer: SdkClientLayer,
): Layer.Layer<AnthropicClient.AnthropicClient, never, HttpClient.HttpClient | R> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const pathContext = yield* Effect.context<R>()
      const rewriteBody = HttpClient.mapRequestEffect(
        (request: HttpClientRequest.HttpClientRequest) =>
          Option.match(Option.flatMap(requestBodyText(request), decodeJsonBody), {
            onNone: () => Effect.succeed(request),
            onSome: (payload) =>
              path.payload(applyRequestPlan(payload, plan)).pipe(
                Effect.provideContext(pathContext),
                Effect.map((body) => {
                  const rewritten = HttpClientRequest.bodyJsonUnsafe(request, body)
                  if (!bindsThinking(body)) return rewritten
                  return withBeta(rewritten, THINKING_BINDING_BETA)
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
const apiKeyClientPath: ClientPath<never> = {
  payload: (payload) => Effect.succeed(markCacheBreakpoints(payload, "system")),
  message: (call) => call,
  stream: (call) => call,
}

/**
 * The Claude Code path: its keychain conventions on the payload, the tool
 * names restored on the reply, and a request that fails on its credential
 * keeps the credential's own message.
 */
const claudeCodeClientPath = (
  creds: CredentialCache<ClaudeCredentials>,
): ClientPath<KeychainTransformRequirements> => {
  const explain = explainCredentialFailure(creds)
  return {
    payload: transformPayload,
    message: (call, toolIds) =>
      explain(call).pipe(
        Effect.map(([body, response]) => {
          const b = Schema.decodeSync(JsonRecordSchema)(body)
          const content = b["content"]
          if (isRecordArray(content)) {
            const transformed = {
              ...b,
              content: transformResponseContent(content, toolIds),
            }
            return [
              Schema.decodeUnknownSync(Generated.BetaMessage)(transformed),
              response,
            ] satisfies CreateMessageReply
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
    const modelId = parseModelIdFromBody(requestBodyText(req))
    return withHeaders(req, buildOauthHeaders(req, fresh.accessToken, modelId, env))
  })

// ── extension ───────────────────────────────────────────────────────────────

// Credential cache + refresh logic live in `makeAnthropicCredentialCache`.
// The OAuth path hands the cache to the keychain transform middleware,
// which reads it per request via `mapRequestEffect`.

/** Anthropic `output_config.effort` levels, lowest first. */
const AnthropicEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])
type AnthropicEffort = typeof AnthropicEffort.Type
const ANTHROPIC_EFFORT_ORDER = AnthropicEffort.literals

/**
 * How a family thinks when a request does not say. From the model table at
 * platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
 * (read 2026-09-23):
 *   - `Off`: thinking stays off until the request sets `{type: "adaptive"}`.
 *   - `On`: thinking is on, and `{type: "disabled"}` turns it off.
 *   - `AlwaysOn`: thinking is on, and a request that disables it gets HTTP 400.
 */
type ThinkingDefault = "Off" | "On" | "AlwaysOn"

interface AnthropicFamily {
  readonly pattern: RegExp
  /** The effort levels the family accepts, lowest first. */
  readonly accepts: ReadonlyArray<AnthropicEffort>
  /** None for a family without adaptive thinking (extended thinking only). */
  readonly thinking: Option.Option<ThinkingDefault>
  /** A non-default `temperature` gets HTTP 400 on every request, thinking or not. */
  readonly fixedSampling: boolean
  /** The family has the 1M-token window; every other Claude model has 200k. */
  readonly millionTokenContext: boolean
}

/**
 * The model families that take effort, first match wins, by substring of the
 * lowercased id. Efforts are from platform.claude.com/docs/en/build-with-claude/effort,
 * thinking from the table above, sampling from the thinking page's "Sampling
 * parameters" section, the window from the context-windows page (all read
 * 2026-09-23). A model no row matches takes no
 * effort and no thinking: Sonnet 4.5, Haiku 4.5 and older models answer HTTP
 * 400 when a request names an effort, so a new family stays plain until it
 * is added here.
 */
const ANTHROPIC_FAMILIES: ReadonlyArray<AnthropicFamily> = [
  {
    pattern: /(fable-5|mythos|opus-5-5)(-|$)/,
    accepts: ["low", "medium", "high", "xhigh", "max"],
    thinking: Option.some("AlwaysOn"),
    fixedSampling: true,
    millionTokenContext: true,
  },
  {
    // Opus 5 accepts `disabled` only at effort `high` or below; `none` names no effort.
    pattern: /(opus-5|sonnet-5)(-|$)/,
    accepts: ["low", "medium", "high", "xhigh", "max"],
    thinking: Option.some("On"),
    fixedSampling: true,
    millionTokenContext: true,
  },
  {
    pattern: /opus-4-[78](-|$)/,
    accepts: ["low", "medium", "high", "xhigh", "max"],
    thinking: Option.some("Off"),
    fixedSampling: true,
    millionTokenContext: true,
  },
  {
    pattern: /(opus|sonnet)-4-6(-|$)/,
    accepts: ["low", "medium", "high", "max"],
    thinking: Option.some("Off"),
    fixedSampling: false,
    millionTokenContext: true,
  },
  {
    pattern: /opus-4-5(-|$)/,
    accepts: ["low", "medium", "high"],
    thinking: Option.none(),
    fixedSampling: false,
    millionTokenContext: false,
  },
]

/** The window of every Claude model outside the 1M families. */
const STANDARD_CONTEXT_TOKENS = 200_000

/**
 * The catalog with each window checked against the docs: models.dev lists
 * 1M for Claude Sonnet 4.5, which has 200k now that no beta widens it, and a
 * request past the real window fails before compaction would start.
 */
const withDocumentedWindows = (models: ReadonlyArray<Model>): ReadonlyArray<Model> =>
  models.map((model) => {
    const lower = model.id.toLowerCase()
    const family = ANTHROPIC_FAMILIES.find((entry) => entry.pattern.test(lower))
    if (family?.millionTokenContext === true) return model
    if (Predicate.isUndefined(model.contextLength)) return model
    if (model.contextLength <= STANDARD_CONTEXT_TOKENS) return model
    return Model.make({ ...model, contextLength: STANDARD_CONTEXT_TOKENS })
  })

/** Each gent reasoning level as an Anthropic effort; `none` asks for no reasoning and is handled per family. */
const HINT_EFFORT = new Map<string, AnthropicEffort>([
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["xhigh", "xhigh"],
  ["max", "max"],
])

/**
 * What one model's requests carry for a reasoning hint. Both auth paths apply
 * it to the request body in `anthropicClientLayer`: the SDK config type cannot
 * name effort `xhigh` or `max`, and effort and thinking are decided together.
 */
interface AnthropicRequestPlan {
  readonly effort: Option.Option<AnthropicEffort>
  readonly thinking: Option.Option<"adaptive" | "disabled">
  /** False where a `temperature` would get HTTP 400. */
  readonly temperature: boolean
}

const PLAIN_REQUEST: AnthropicRequestPlan = {
  effort: Option.none(),
  thinking: Option.none(),
  temperature: true,
}

/**
 * The request plan for a model and a hint.
 *
 * - No hint: the model's own defaults.
 * - `none`: as little reasoning as the model allows. A family that can turn
 *   thinking off does; an always-on family runs at its lowest effort. The
 *   compaction summary asks for this under a 768-token cap, and thinking
 *   counts toward `max_tokens`, so a thinking summary can come back cut or
 *   empty.
 * - A level: the lowest effort the family accepts at or above it, else its
 *   highest, with adaptive thinking on, which an `Off` family needs to reason.
 */
const anthropicRequestPlan = (
  modelName: string,
  hint: ProviderHints["reasoning"],
): AnthropicRequestPlan => {
  const lower = modelName.toLowerCase()
  const family = ANTHROPIC_FAMILIES.find((entry) => entry.pattern.test(lower))
  if (Predicate.isUndefined(family)) return PLAIN_REQUEST
  if (Predicate.isUndefined(hint)) {
    // A family that thinks by default is sent `adaptive`, its own default,
    // so that the thinking display below applies to it.
    return {
      effort: Option.none(),
      thinking: Option.map(
        Option.filter(family.thinking, (value) => value !== "Off"),
        () => "adaptive",
      ),
      temperature: !family.fixedSampling,
    }
  }
  if (hint === "none") {
    const thinkingDefault = Option.getOrUndefined(family.thinking)
    if (thinkingDefault === "On") {
      return { effort: Option.none(), thinking: Option.some("disabled"), temperature: false }
    }
    if (thinkingDefault === "AlwaysOn") {
      const lowest = Option.fromUndefinedOr(family.accepts[0])
      return {
        effort: lowest,
        thinking: Option.none(),
        temperature: false,
      }
    }
    return { ...PLAIN_REQUEST, temperature: !family.fixedSampling }
  }
  const effort = Option.fromUndefinedOr(HINT_EFFORT.get(hint)).pipe(
    Option.flatMap((level) => effortAtOrAbove(ANTHROPIC_EFFORT_ORDER, family.accepts, level)),
  )
  const thinking: AnthropicRequestPlan["thinking"] = Option.map(family.thinking, () => "adaptive")
  // Before the 4.7 families, `temperature` conflicts only with thinking on.
  return { effort, thinking, temperature: !family.fixedSampling && Option.isNone(thinking) }
}

type AnthropicConfig = Required<Parameters<typeof AnthropicLanguageModel.layer>[0]>["config"]

/** One model's requests: the SDK config and the plan the client layer applies. */
interface AnthropicRequest {
  /** The output cap, and `temperature` where the model takes one. */
  readonly config: AnthropicConfig
  readonly plan: AnthropicRequestPlan
}

const anthropicRequest = (
  modelName: string,
  hints: Option.Option<ProviderHints>,
): AnthropicRequest => {
  const plan = anthropicRequestPlan(
    modelName,
    Option.getOrUndefined(
      Option.flatMap(hints, (value) => Option.fromUndefinedOr(value.reasoning)),
    ),
  )
  let config: AnthropicConfig = {}
  if (Option.isSome(hints)) {
    const maxTokens = Option.fromNullishOr(hints.value.maxTokens)
    if (Option.isSome(maxTokens)) config = { ...config, max_tokens: maxTokens.value }
    const temperature = Option.fromNullishOr(hints.value.temperature)
    if (Option.isSome(temperature) && plan.temperature) {
      config = { ...config, temperature: temperature.value }
    }
  }
  return { config, plan }
}

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
} satisfies Record<"adaptive" | "disabled", JsonRecord>

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

/** The payload with the plan's effort and thinking; any `output_config` the SDK set is kept. */
const applyRequestPlan = (payload: JsonRecord, plan: AnthropicRequestPlan): JsonRecord => {
  let result = payload
  if (Option.isSome(plan.thinking)) {
    result = { ...result, thinking: THINKING_CONFIG[plan.thinking.value] }
  }
  if (Option.isSome(plan.effort)) {
    const current = result["output_config"]
    let outputConfig: JsonRecord = {}
    if (isRecord(current)) outputConfig = current
    result = { ...result, output_config: { ...outputConfig, effort: plan.effort.value } }
  }
  return result
}

// ── Layer construction helpers ──

/**
 * API-key path: plain `AnthropicClient.layer` over `FetchHttpClient`.
 * No keychain wrapper — `keychainClient` injects Claude Code OAuth
 * billing-header system blocks + identity prefix, which API-key users
 * are not on the hook for.
 */
const makeApiKeyAnthropicLayer = (modelName: string, request: AnthropicRequest, apiKey: string) => {
  const clientLayer = anthropicClientLayer(request.plan, apiKeyClientPath, (rewriteBody) =>
    AnthropicClient.layer({ apiKey: Redacted.make(apiKey), transformClient: rewriteBody }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
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
  modelName: string,
  request: AnthropicRequest,
  creds: CredentialCache<ClaudeCredentials>,
  services: AnthropicDriverServices,
) => {
  const keychain = buildKeychainTransformClient(creds, Context.get(services, AnthropicPlatform).env)
  const wrappedClient = anthropicClientLayer(
    request.plan,
    claudeCodeClientPath(creds),
    (rewriteBody) =>
      AnthropicClient.layer({ transformClient: (client) => keychain(rewriteBody(client)) }),
  ).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeedContext(services)))
  return AnthropicLanguageModel.layer({ model: modelName, config: request.config }).pipe(
    Layer.provide(wrappedClient),
  )
}

/**
 * Build the model-driver contribution given the pre-allocated credential
 * cell. Extracted from the inline `modelDrivers` factory so tests can
 * inject their own cell and assert that two `resolveModel` calls share
 * the closure-owned cell (a fresh cell per `resolveModel` would kill
 * credential reuse).
 */
export const buildAnthropicModelDriver = (
  credentialCellRef: CredentialCacheCellRef<ClaudeCredentials>,
  envApiKey: Option.Option<string>,
  services: AnthropicDriverServices,
  catalog: CatalogSource,
): ModelDriverContribution => ({
  id: "anthropic",
  name: "Anthropic",
  envCredential: "ANTHROPIC_API_KEY",
  listModels: () => Effect.map(driverListModels(catalog, "anthropic")(), withDocumentedWindows),
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
      const request = anthropicRequest(modelName, Option.fromNullishOr(hints))

      // Precedence, the same as OpenAI: stored Claude Code sign-in, then
      // stored API key, then ANTHROPIC_API_KEY. A user who chooses Claude
      // Code in /auth is not billed on a shell API key.
      if (Option.isSome(auth) && auth.value._tag === "Oauth") {
        // The credential cache is built over the extension-closure-owned
        // cell, so credential reuse survives. The credentials are checked before the
        // layer exists, so an expired sign-in fails with its own message.
        const creds = yield* buildLiveCredentialCache(credentialCellRef, services)
        yield* checkCredentials(creds)
        return AiModel.make(
          "anthropic",
          modelName,
          makeOauthAnthropicLayer(modelName, request, creds, services),
        )
      }

      const apiKey = apiKeyFrom(auth, envApiKey)
      if (Option.isSome(apiKey)) {
        return AiModel.make(
          "anthropic",
          modelName,
          makeApiKeyAnthropicLayer(modelName, request, apiKey.value),
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
      AuthMethod.make({ type: "oauth", label: "Claude Code" }),
      AuthMethod.make({ type: "api", label: "Manually enter API key" }),
    ],
    authorize: (ctx) =>
      Effect.gen(function* () {
        if (ctx.methodIndex !== 0) return Option.none()
        // The Claude Code authorize flow reads the primary account.
        let creds = yield* readClaudeCodeCredentials
        const now = yield* Clock.currentTimeMillis
        if (!freshEnoughAt(creds.expiresAt, now)) {
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
        Effect.provideContext(services),
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

    // Cache cells are hoisted to extension-closure scope so they
    // survive across `resolveModel` calls. Lifetime: one extension
    // instance → one cell that lives until the runtime tears the
    // extension down. Setup is Effectful, so cache cells are allocated
    // through SynchronizedRef.make instead of an unsafe closure escape hatch.
    const credentialCellRef =
      yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)

    const catalog = yield* catalogSource(ctx.home)

    yield* ctx.register(
      "modelDriver",
      buildAnthropicModelDriver(credentialCellRef, envApiKey, services, catalog),
    )
  }),
})
