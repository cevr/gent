import { Duration, Effect, Schema } from "effect"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { decodeCredentials, type ClaudeCredentials } from "./credentials.js"
import { AnthropicPlatform } from "../platform-adapter.js"

/**
 * Default keychain service name and on-disk file path. Counsel K2
 * called out that hard-coding the primary service silently broke any
 * future multi-account UI consumer — every credential helper now takes
 * an explicit `source` so callers spell out which account they mean.
 */
export const PRIMARY_CLAUDE_SERVICE = "Claude Code-credentials"

export class ClaudeKeychainNotFoundError extends Schema.TaggedErrorClass<ClaudeKeychainNotFoundError>()(
  "ClaudeKeychainNotFoundError",
  {},
) {}

export const spawnSecurity = (
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

export const readFromKeychain = (
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
export const getKeychainAccountName = (
  serviceName: string,
): Effect.Effect<string | undefined, never, AnthropicPlatform> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    return yield* platform
      .runProcess("security", ["find-generic-password", "-s", serviceName], {
        timeout: Duration.millis(2000),
      })
      .pipe(
        Effect.map((result) => {
          const match = /"acct"<blob>="([^"]*)"/.exec(result.stdout)
          return match?.[1]
        }),
        Effect.catchEager(() => Effect.sync((): string | undefined => undefined)),
      )
  })

export const writeKeychainEntry = (
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
