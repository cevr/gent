import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  it.live("corrupt auth files fail closed and do not get overwritten by writes", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gent-auth-storage-"))
      const authPath = join(dir, "auth.json.enc")
      const keyPath = join(dir, "auth.key")
      yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const storage = yield* AuthStorage
              yield* storage.set("openai", "sk-original")
              writeFileSync(authPath, "not-json")
              const corruptContent = readFileSync(authPath, "utf8")
              const setExit = yield* Effect.exit(storage.set("anthropic", "sk-new"))
              expect(setExit._tag).toBe("Failure")
              expect(readFileSync(authPath, "utf8")).toBe(corruptContent)
              const deleteExit = yield* Effect.exit(storage.delete("openai"))
              expect(deleteExit._tag).toBe("Failure")
              expect(readFileSync(authPath, "utf8")).toBe(corruptContent)
            }).pipe(Effect.provide(encryptedFileLayer(authPath, keyPath)))
          }),
        () =>
          Effect.sync(() => {
            rmSync(dir, { recursive: true, force: true })
          }),
      )
    }),
  )
})
