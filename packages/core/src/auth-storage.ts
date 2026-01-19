import { Context, Effect, Layer, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"

// Auth Storage Error

export class AuthStorageError extends Schema.TaggedError<AuthStorageError>()(
  "AuthStorageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

// Auth Storage Service Interface

export interface AuthStorageService {
  readonly get: (
    provider: string
  ) => Effect.Effect<string | undefined, AuthStorageError>
  readonly set: (
    provider: string,
    key: string
  ) => Effect.Effect<void, AuthStorageError>
  readonly delete: (provider: string) => Effect.Effect<void, AuthStorageError>
  readonly list: () => Effect.Effect<ReadonlyArray<string>, AuthStorageError>
}

// Auth Storage Service Tag

export class AuthStorage extends Context.Tag("AuthStorage")<
  AuthStorage,
  AuthStorageService
>() {
  // macOS Keychain implementation
  static LiveKeychain = (
    serviceName: string = "gent"
  ): Layer.Layer<AuthStorage> =>
    Layer.effect(
      AuthStorage,
      Effect.gen(function* () {
        const exec = (cmd: string) =>
          Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(["sh", "-c", cmd], {
                stdout: "pipe",
                stderr: "pipe",
              })
              const text = await new Response(proc.stdout).text()
              const code = await proc.exited
              if (code !== 0) {
                const err = await new Response(proc.stderr).text()
                throw new Error(err || `Exit code ${code}`)
              }
              return text.trim()
            },
            catch: (e) =>
              new AuthStorageError({
                message: `Keychain command failed: ${e instanceof Error ? e.message : String(e)}`,
                cause: e,
              }),
          })

        return {
          get: (provider) =>
            exec(
              `security find-generic-password -s "${serviceName}" -a "${provider}" -w 2>/dev/null`
            ).pipe(
              Effect.map((key) => (key ? key : undefined)),
              Effect.catchAll(() => Effect.succeed(undefined))
            ),

          set: (provider, key) =>
            exec(
              `security delete-generic-password -s "${serviceName}" -a "${provider}" 2>/dev/null; security add-generic-password -s "${serviceName}" -a "${provider}" -w "${key}"`
            ).pipe(Effect.asVoid),

          delete: (provider) =>
            exec(
              `security delete-generic-password -s "${serviceName}" -a "${provider}" 2>/dev/null`
            ).pipe(
              Effect.asVoid,
              Effect.catchAll(() => Effect.void)
            ),

          list: () =>
            exec(
              `security dump-keychain | grep -A4 '"svce"<blob>="${serviceName}"' | grep '"acct"<blob>=' | sed 's/.*="\\([^"]*\\)".*/\\1/'`
            ).pipe(
              Effect.map((output) =>
                output
                  .split("\n")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0)
              ),
              Effect.catchAll(() => Effect.succeed([]))
            ),
        }
      })
    )

  // File-based implementation (fallback)
  static LiveFile = (
    filePath: string
  ): Layer.Layer<AuthStorage, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Layer.scoped(
      AuthStorage,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.dirname(filePath)

        yield* fs.makeDirectory(dir, { recursive: true })

        type AuthData = Record<string, string>

        const readData = (): Effect.Effect<AuthData, AuthStorageError> =>
          fs.exists(filePath).pipe(
            Effect.flatMap((exists) => {
              if (!exists) return Effect.succeed("{}")
              return fs.readFileString(filePath)
            }),
            Effect.map((content) => JSON.parse(content) as AuthData),
            Effect.mapError(
              (e) =>
                new AuthStorageError({
                  message: "Failed to read auth file",
                  cause: e,
                })
            ),
            Effect.catchAll(() => Effect.succeed({} as AuthData))
          )

        const writeData = (data: AuthData): Effect.Effect<void, AuthStorageError> =>
          fs
            .writeFileString(filePath, JSON.stringify(data, null, 2))
            .pipe(
              Effect.mapError(
                (e) =>
                  new AuthStorageError({
                    message: "Failed to write auth file",
                    cause: e,
                  })
              )
            )

        return {
          get: (provider) =>
            readData().pipe(Effect.map((data) => data[provider])),

          set: (provider, key) =>
            readData().pipe(
              Effect.flatMap((data) => writeData({ ...data, [provider]: key }))
            ),

          delete: (provider) =>
            readData().pipe(
              Effect.flatMap((data) => {
                const { [provider]: _removed, ...rest } = data
                void _removed
                return writeData(rest)
              })
            ),

          list: () =>
            readData().pipe(Effect.map((data) => Object.keys(data))),
        }
      })
    )

  // Test implementation
  static Test = (
    initialKeys: Record<string, string> = {}
  ): Layer.Layer<AuthStorage> => {
    const keys = new Map(Object.entries(initialKeys))
    return Layer.succeed(AuthStorage, {
      get: (provider) => Effect.succeed(keys.get(provider)),
      set: (provider, key) =>
        Effect.sync(() => {
          keys.set(provider, key)
        }),
      delete: (provider) =>
        Effect.sync(() => {
          keys.delete(provider)
        }),
      list: () => Effect.succeed([...keys.keys()]),
    })
  }
}
