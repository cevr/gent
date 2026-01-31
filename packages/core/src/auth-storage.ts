import { Config, Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Buffer } from "node:buffer"
import * as os from "node:os"

// Auth Storage Error

export class AuthStorageError extends Schema.TaggedError<AuthStorageError>()("AuthStorageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// Auth Storage Service Interface

export interface AuthStorageService {
  readonly get: (provider: string) => Effect.Effect<string | undefined, AuthStorageError>
  readonly set: (provider: string, key: string) => Effect.Effect<void, AuthStorageError>
  readonly delete: (provider: string) => Effect.Effect<void, AuthStorageError>
  readonly list: () => Effect.Effect<ReadonlyArray<string>, AuthStorageError>
}

// Auth Storage Service Tag

export class AuthStorage extends Context.Tag("@gent/core/src/auth-storage/AuthStorage")<
  AuthStorage,
  AuthStorageService
>() {
  static LiveSystem = (
    options: {
      serviceName?: string
      filePath?: string
      keyPath?: string
    } = {},
  ): Layer.Layer<AuthStorage, PlatformError, FileSystem.FileSystem | Path.Path> =>
    process.platform === "darwin" && options.filePath === undefined && options.keyPath === undefined
      ? AuthStorage.LiveKeychain(options.serviceName ?? "gent")
      : Layer.unwrapEffect(
          Effect.gen(function* () {
            const home = yield* Config.option(Config.string("HOME")).pipe(
              Effect.catchAll(() => Effect.succeed(Option.none())),
              Effect.map(Option.getOrElse(() => os.homedir())),
            )
            const filePath = options.filePath ?? `${home}/.gent/auth.json.enc`
            const keyPath = options.keyPath ?? `${home}/.gent/auth.key`
            return AuthStorage.LiveEncryptedFile(filePath, keyPath)
          }),
        )

  // macOS Keychain implementation
  static LiveKeychain = (serviceName: string = "gent"): Layer.Layer<AuthStorage> =>
    Layer.effect(
      AuthStorage,
      Effect.sync(() => {
        const execSecurity = (args: string[]) =>
          Effect.tryPromise({
            try: async () => {
              const proc = Bun.spawn(["security", ...args], {
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

        const execShell = (cmd: string) =>
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
            execSecurity(["find-generic-password", "-s", serviceName, "-a", provider, "-w"]).pipe(
              Effect.map((key) => (key.length > 0 ? key : undefined)),
              Effect.catchAll(() => Effect.succeed(undefined)),
            ),

          set: (provider, key) =>
            execSecurity(["delete-generic-password", "-s", serviceName, "-a", provider]).pipe(
              Effect.catchAll(() => Effect.void),
              Effect.flatMap(() =>
                execSecurity([
                  "add-generic-password",
                  "-s",
                  serviceName,
                  "-a",
                  provider,
                  "-w",
                  key,
                ]),
              ),
              Effect.asVoid,
            ),

          delete: (provider) =>
            execSecurity(["delete-generic-password", "-s", serviceName, "-a", provider]).pipe(
              Effect.asVoid,
              Effect.catchAll(() => Effect.void),
            ),

          list: () =>
            execShell(
              `security dump-keychain | grep -A4 '"svce"<blob>="${serviceName}"' | grep '"acct"<blob>=' | sed 's/.*="\\([^"]*\\)".*/\\1/'`,
            ).pipe(
              Effect.map((output) =>
                output
                  .split("\n")
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0),
              ),
              Effect.catchAll(() => Effect.succeed([])),
            ),
        }
      }),
    )

  // File-based implementation (fallback)
  static LiveFile = (
    filePath: string,
  ): Layer.Layer<AuthStorage, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Layer.scoped(
      AuthStorage,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.dirname(filePath)

        yield* fs.makeDirectory(dir, { recursive: true })

        const AuthData = Schema.Record({ key: Schema.String, value: Schema.String })
        type AuthData = typeof AuthData.Type
        const AuthDataJson = Schema.parseJson(AuthData)

        const readData = (): Effect.Effect<AuthData, AuthStorageError> =>
          fs.exists(filePath).pipe(
            Effect.flatMap((exists) => {
              if (!exists) return Effect.succeed("{}")
              return fs.readFileString(filePath)
            }),
            Effect.flatMap((content) =>
              Schema.decodeUnknown(AuthDataJson)(content).pipe(
                Effect.mapError(
                  (e) =>
                    new AuthStorageError({
                      message: "Failed to parse auth file",
                      cause: e,
                    }),
                ),
              ),
            ),
            Effect.catchAll(() => Effect.succeed({} as AuthData)),
          )

        const writeData = (data: AuthData): Effect.Effect<void, AuthStorageError> =>
          Schema.encode(AuthDataJson)(data).pipe(
            Effect.flatMap((json) => fs.writeFileString(filePath, json)),
            Effect.mapError(
              (e) =>
                new AuthStorageError({
                  message: "Failed to write auth file",
                  cause: e,
                }),
            ),
          )

        return {
          get: (provider) => readData().pipe(Effect.map((data) => data[provider])),

          set: (provider, key) =>
            readData().pipe(Effect.flatMap((data) => writeData({ ...data, [provider]: key }))),

          delete: (provider) =>
            readData().pipe(
              Effect.flatMap((data) => {
                const { [provider]: _removed, ...rest } = data
                void _removed
                return writeData(rest)
              }),
            ),

          list: () => readData().pipe(Effect.map((data) => Object.keys(data))),
        }
      }),
    )

  // Encrypted file-based implementation (fallback)
  static LiveEncryptedFile = (
    filePath: string,
    keyPath: string,
  ): Layer.Layer<AuthStorage, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Layer.scoped(
      AuthStorage,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = path.dirname(filePath)
        const keyDir = path.dirname(keyPath)

        yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.makeDirectory(keyDir, { recursive: true })

        const AuthData = Schema.Record({ key: Schema.String, value: Schema.String })
        type AuthData = typeof AuthData.Type
        const AuthDataJson = Schema.parseJson(AuthData)

        const EncryptedAuthFile = Schema.Struct({
          v: Schema.Number,
          iv: Schema.String,
          data: Schema.String,
        })
        type EncryptedAuthFile = typeof EncryptedAuthFile.Type
        const EncryptedAuthFileJson = Schema.parseJson(EncryptedAuthFile)

        const textEncoder = new TextEncoder()
        const textDecoder = new TextDecoder()

        const toBase64 = (data: Uint8Array): string => Buffer.from(data).toString("base64")
        const fromBase64 = (data: string): ArrayBuffer =>
          Buffer.from(data, "base64").buffer.slice(0)

        const loadKey = (): Effect.Effect<CryptoKey, AuthStorageError> =>
          fs.exists(keyPath).pipe(
            Effect.mapError(
              (e) =>
                new AuthStorageError({
                  message: "Failed to read auth key",
                  cause: e,
                }),
            ),
            Effect.flatMap((exists) => {
              if (!exists) {
                const raw = crypto.getRandomValues(new Uint8Array(32))
                const encoded = toBase64(raw)
                return fs.writeFileString(keyPath, encoded).pipe(
                  Effect.as(raw.buffer.slice(0)),
                  Effect.mapError(
                    (e) =>
                      new AuthStorageError({
                        message: "Failed to write auth key",
                        cause: e,
                      }),
                  ),
                )
              }
              return fs.readFileString(keyPath).pipe(
                Effect.map(fromBase64),
                Effect.mapError(
                  (e) =>
                    new AuthStorageError({
                      message: "Failed to read auth key",
                      cause: e,
                    }),
                ),
              )
            }),
            Effect.flatMap((raw) =>
              Effect.tryPromise({
                try: () =>
                  crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
                    "encrypt",
                    "decrypt",
                  ]),
                catch: (e) =>
                  new AuthStorageError({
                    message: "Failed to load auth encryption key",
                    cause: e,
                  }),
              }),
            ),
          )

        const encrypt = (key: CryptoKey, data: AuthData): Effect.Effect<string, AuthStorageError> =>
          Effect.tryPromise({
            try: async () => {
              const iv = crypto.getRandomValues(new Uint8Array(12))
              const payload = textEncoder.encode(JSON.stringify(data))
              const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload)
              const file: EncryptedAuthFile = {
                v: 1,
                iv: toBase64(iv),
                data: toBase64(new Uint8Array(encrypted)),
              }
              return JSON.stringify(file)
            },
            catch: (e) =>
              new AuthStorageError({
                message: "Failed to encrypt auth file",
                cause: e,
              }),
          })

        const decrypt = (
          key: CryptoKey,
          content: string,
        ): Effect.Effect<AuthData, AuthStorageError> =>
          Schema.decodeUnknown(EncryptedAuthFileJson)(content).pipe(
            Effect.mapError(
              (e) =>
                new AuthStorageError({
                  message: "Failed to parse auth file",
                  cause: e,
                }),
            ),
            Effect.flatMap((file) =>
              Effect.tryPromise({
                try: async () => {
                  const iv = new Uint8Array(fromBase64(file.iv))
                  const cipher = fromBase64(file.data)
                  const decrypted = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv },
                    key,
                    cipher,
                  )
                  const decoded = textDecoder.decode(new Uint8Array(decrypted))
                  return decoded
                },
                catch: (e) =>
                  new AuthStorageError({
                    message: "Failed to decrypt auth file",
                    cause: e,
                  }),
              }),
            ),
            Effect.flatMap((decoded) =>
              Schema.decodeUnknown(AuthDataJson)(decoded).pipe(
                Effect.mapError(
                  (e) =>
                    new AuthStorageError({
                      message: "Failed to parse auth data",
                      cause: e,
                    }),
                ),
              ),
            ),
            Effect.catchAll(() => Effect.succeed({} as AuthData)),
          )

        const readData = (key: CryptoKey): Effect.Effect<AuthData, AuthStorageError> =>
          fs.exists(filePath).pipe(
            Effect.flatMap((exists) => {
              if (!exists) return Effect.succeed(undefined)
              return fs.readFileString(filePath).pipe(Effect.map((content) => content.trim()))
            }),
            Effect.flatMap((content) => {
              if (content === undefined || content.length === 0)
                return Effect.succeed({} as AuthData)
              return decrypt(key, content)
            }),
            Effect.catchAll(() => Effect.succeed({} as AuthData)),
          )

        const writeData = (key: CryptoKey, data: AuthData): Effect.Effect<void, AuthStorageError> =>
          encrypt(key, data).pipe(
            Effect.flatMap((json) => fs.writeFileString(filePath, json)),
            Effect.mapError(
              (e) =>
                new AuthStorageError({
                  message: "Failed to write auth file",
                  cause: e,
                }),
            ),
          )

        const keyRef = yield* Ref.make<Option.Option<CryptoKey>>(Option.none())
        const getKey = Effect.gen(function* () {
          const cached = yield* Ref.get(keyRef)
          if (Option.isSome(cached)) return cached.value
          const key = yield* loadKey()
          yield* Ref.set(keyRef, Option.some(key))
          return key
        })

        return {
          get: (provider) =>
            getKey.pipe(
              Effect.flatMap((key) => readData(key).pipe(Effect.map((data) => data[provider]))),
            ),

          set: (provider, value) =>
            getKey.pipe(
              Effect.flatMap((key) =>
                readData(key).pipe(
                  Effect.flatMap((data) => writeData(key, { ...data, [provider]: value })),
                ),
              ),
            ),

          delete: (provider) =>
            getKey.pipe(
              Effect.flatMap((key) =>
                readData(key).pipe(
                  Effect.flatMap((data) => {
                    const { [provider]: _removed, ...rest } = data
                    void _removed
                    return writeData(key, rest)
                  }),
                ),
              ),
            ),

          list: () =>
            getKey.pipe(
              Effect.flatMap((key) => readData(key).pipe(Effect.map((data) => Object.keys(data)))),
            ),
        }
      }),
    )

  // Test implementation
  static Test = (initialKeys: Record<string, string> = {}): Layer.Layer<AuthStorage> => {
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
