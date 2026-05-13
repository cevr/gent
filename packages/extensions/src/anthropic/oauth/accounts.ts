import { Duration, Effect, Schema, type FileSystem, type Path } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { updateCredentialBlob, type ClaudeCredentials } from "./credentials.js"
import { readCredentialsFile, writeCredentialsFile } from "./credentials-file.js"
import {
  ClaudeKeychainNotFoundError,
  getKeychainAccountName,
  PRIMARY_CLAUDE_SERVICE,
  readFromKeychain,
  shouldFallBackToCredentialsFile,
  spawnSecurity,
  writeKeychainEntry,
} from "./keychain.js"
import { AnthropicPlatform } from "../platform-adapter.js"

/**
 * Read Claude Code credentials for `source` (the keychain service name).
 * Use `PRIMARY_CLAUDE_SERVICE` for the default account; pass another
 * service from `listClaudeCodeKeychainServices()` for additional ones.
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
      return yield* readCredentialsFile()
    }
    return yield* readFromKeychain(source).pipe(
      Effect.catchIf(Schema.is(ClaudeKeychainNotFoundError), () =>
        shouldFallBackToCredentialsFile(platform.platform, source)
          ? readCredentialsFile()
          : Effect.fail(
              new ProviderAuthError({
                message: `No Claude credentials found in keychain for source: ${source}`,
              }),
            ),
      ),
    )
  })

/**
 * Enumerate every `Claude Code-credentials*` keychain entry — the CLI
 * stores per-account credentials with the suffix `-<random hex>`. Used
 * to surface multiple Claude accounts in the auth picker. Returns the
 * primary first, then the rest in keychain dump order.
 *
 * On non-darwin (no keychain), or when `dump-keychain` itself fails,
 * returns just the primary so callers fall back to the existing
 * single-credential path.
 */
export const listClaudeCodeKeychainServices = (): Effect.Effect<
  ReadonlyArray<string>,
  ProviderAuthError,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const platform = yield* AnthropicPlatform
    if (platform.platform !== "darwin") return [PRIMARY_CLAUDE_SERVICE] as ReadonlyArray<string>
    const result = yield* platform
      .runProcess("security", ["dump-keychain"], {
        timeout: Duration.millis(5000),
      })
      .pipe(Effect.catchEager(() => Effect.sync(() => undefined)))
    if (result === undefined || result.exitCode !== 0)
      return [PRIMARY_CLAUDE_SERVICE] as ReadonlyArray<string>
    const services: string[] = []
    const seen = new Set<string>()
    const re = /"Claude Code-credentials(?:-[0-9a-f]+)?"/g
    let m = re.exec(result.stdout)
    while (m !== null) {
      const svc = m[0].slice(1, -1)
      if (!seen.has(svc)) {
        seen.add(svc)
        services.push(svc)
      }
      m = re.exec(result.stdout)
    }
    const ordered: string[] = []
    if (seen.has(PRIMARY_CLAUDE_SERVICE)) ordered.push(PRIMARY_CLAUDE_SERVICE)
    for (const svc of services) {
      if (svc !== PRIMARY_CLAUDE_SERVICE) ordered.push(svc)
    }
    return (ordered.length > 0 ? ordered : [PRIMARY_CLAUDE_SERVICE]) as ReadonlyArray<string>
  })

/**
 * One Claude account discovered on this machine. `source` is the
 * keychain service name (or `"file"` on non-darwin) and is what every
 * source-aware credential helper expects. `label` is the
 * human-readable account name (the keychain `acct` field, e.g.
 * `"alice@example.com"`) — this is what the auth picker UI displays.
 */
export interface ClaudeAccount {
  readonly source: string
  readonly label: string
  readonly credentials: ClaudeCredentials
}

/**
 * Discover every Claude Code account on this machine: enumerate the
 * keychain services, read each credential, and pair it with its
 * keychain `acct` label. Accounts whose credentials fail to decode
 * are dropped (the slot may exist but be empty / corrupted) — the
 * list returned is ready to render in a picker.
 *
 * Foundation for the multi-account auth UI.
 */
export const listClaudeAccounts = (): Effect.Effect<
  ReadonlyArray<ClaudeAccount>,
  never,
  AnthropicPlatform | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const sources = yield* listClaudeCodeKeychainServices().pipe(
      Effect.catchEager(() => Effect.succeed([PRIMARY_CLAUDE_SERVICE] as ReadonlyArray<string>)),
    )
    const accounts: ClaudeAccount[] = []
    for (const source of sources) {
      const credentials = yield* readClaudeCodeCredentials(source).pipe(
        Effect.catchEager(() => Effect.sync((): ClaudeCredentials | undefined => undefined)),
      )
      if (credentials === undefined) continue
      const label = (yield* getKeychainAccountName(source)) ?? source
      accounts.push({ source, label, credentials })
    }
    return accounts
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
    if (updated === undefined) return
    const accountName = (yield* getKeychainAccountName(source)) ?? source
    yield* writeKeychainEntry(source, accountName, updated)
  })
