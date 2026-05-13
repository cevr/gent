import { Effect, FileSystem, Path } from "effect"
import { ProviderAuthError } from "@gent/core/extensions/api"
import { decodeCredentials, updateCredentialBlob, type ClaudeCredentials } from "./credentials.js"
import { AnthropicPlatform } from "../platform-adapter.js"

export const credentialsFilePath = (home: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(home, ".claude", ".credentials.json")
  })

export const readCredentialsFile = (): Effect.Effect<
  ClaudeCredentials,
  ProviderAuthError,
  AnthropicPlatform | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
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

export const writeCredentialsFile = (
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
    const raw = exists
      ? yield* fs.readFileString(credentialsFile).pipe(Effect.mapError(mapFsError))
      : '{"claudeAiOauth":{}}'
    const updated = updateCredentialBlob(raw, creds)
    if (updated === undefined) return
    yield* fs.writeFileString(credentialsFile, updated).pipe(Effect.mapError(mapFsError))
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
