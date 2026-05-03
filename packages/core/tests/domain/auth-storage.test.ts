import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit, FileSystem, Layer, Path } from "effect"
import { AuthStorage, type KeychainRunResult } from "@gent/core/domain/auth-storage"
const encryptedFileLayer = (authPath: string, keyPath: string) =>
  AuthStorage.LiveEncryptedFile(authPath, keyPath).pipe(Layer.provide(BunServices.layer))
const keychainLayer = (
  serviceName: string,
  options: Parameters<typeof AuthStorage.LiveKeychain>[1],
) => AuthStorage.LiveKeychain(serviceName, options).pipe(Layer.provide(BunServices.layer))
describe("AuthStorage.LiveKeychain classification", () => {
  // `LiveKeychain` accepts an injected `runSecurity` runner. The tests
  // here stub it to drive classification behavior without touching the
  // real macOS `security` binary.
  const stubRunner = (result: KeychainRunResult) => () => Effect.succeed(result)
  it.live("missing keychain item reads back undefined (exit 44)", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const storage = yield* AuthStorage
        return yield* storage.get("openai")
      }).pipe(
        Effect.provide(
          keychainLayer("gent-test", {
            runSecurity: stubRunner({
              exitCode: 44,
              stdout: "",
              stderr: "security: The specified item could not be found in the keychain.",
            }),
          }),
        ),
      )
      expect(result).toBeUndefined()
    }),
  )
  it.live("locked keychain (exit 36) surfaces as AuthStorageError, not silent undefined", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const storage = yield* AuthStorage
          return yield* storage.get("openai")
        }).pipe(
          Effect.provide(
            keychainLayer("gent-test", {
              runSecurity: stubRunner({
                exitCode: 36,
                stdout: "",
                stderr: "SecKeychainSearchCopyNext: User interaction is not allowed.",
              }),
            }),
          ),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const msg = String(exit.cause)
        expect(msg).toContain("exit 36")
        expect(msg).toContain("User interaction is not allowed")
      }
    }),
  )
  it.live("deleting a missing keychain item surfaces AuthStorageError (exit 44)", () =>
    Effect.gen(function* () {
      // delete must treat item-not-found as a real error — the caller asked
      // to remove something that doesn't exist, which is an invariant
      // violation worth surfacing, unlike `get` where missing is a valid
      // "no credential stored" state.
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const storage = yield* AuthStorage
          return yield* storage.delete("openai")
        }).pipe(
          Effect.provide(
            keychainLayer("gent-test", {
              runSecurity: stubRunner({
                exitCode: 44,
                stdout: "",
                stderr: "",
              }),
            }),
          ),
        ),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
describe("AuthStorage.LiveEncryptedFile", () => {
  const encryptedFileTest = it.scopedLive.layer(BunServices.layer)
  encryptedFileTest("corrupt auth files fail closed and do not get overwritten by writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped()
      const authPath = path.join(dir, "auth.json.enc")
      const keyPath = path.join(dir, "auth.key")
      yield* Effect.gen(function* () {
        const storage = yield* AuthStorage
        yield* storage.set("openai", "sk-original")
        yield* fs.writeFileString(authPath, "not-json")
        const corruptContent = yield* fs.readFileString(authPath)
        const setExit = yield* Effect.exit(storage.set("anthropic", "sk-new"))
        expect(setExit._tag).toBe("Failure")
        expect(yield* fs.readFileString(authPath)).toBe(corruptContent)
        const deleteExit = yield* Effect.exit(storage.delete("openai"))
        expect(deleteExit._tag).toBe("Failure")
        expect(yield* fs.readFileString(authPath)).toBe(corruptContent)
      }).pipe(Effect.provide(encryptedFileLayer(authPath, keyPath)))
    }),
  )
})
