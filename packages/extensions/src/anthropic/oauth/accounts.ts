import { Effect, Option, Schema, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { updateCredentialBlob, type ClaudeCredentials } from "./credentials.js"
import { readCredentialsFile, writeCredentialsFile } from "./credentials-file.js"
import {
  ClaudeKeychainNotFoundError,
  getKeychainAccountName,
  readFromKeychain,
  shouldFallBackToCredentialsFile,
  spawnSecurity,
  writeKeychainEntry,
} from "./keychain.js"
import { AnthropicPlatform } from "../platform-adapter.js"

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
export const readClaudeCodeCredentials = (
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
export const writeBackCredentials = (
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
