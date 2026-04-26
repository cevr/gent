import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthStorage, type KeychainRunResult } from "@gent/core/domain/auth-storage"

const encryptedFileLayer = (authPath: string, keyPath: string) =>
  AuthStorage.LiveEncryptedFile(authPath, keyPath).pipe(Layer.provide(BunServices.layer))

describe("AuthStorage.LiveKeychain classification", () => {
  // `LiveKeychain` accepts an injected `runSecurity` runner. The tests
  // here stub it to drive classification behavior without touching the
  // real macOS `security` binary.

  const stubRunner = (result: KeychainRunResult) => () => Promise.resolve(result)

  test("missing keychain item reads back undefined (exit 44)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* AuthStorage
        return yield* storage.get("openai")
      }).pipe(
        Effect.provide(
          AuthStorage.LiveKeychain("gent-test", {
            runSecurity: stubRunner({
              exitCode: 44,
              stdout: "",
              stderr: "security: The specified item could not be found in the keychain.",
            }),
          }),
        ),
      ),
    )
    expect(result).toBeUndefined()
  })

  test("locked keychain (exit 36) surfaces as AuthStorageError, not silent undefined", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* AuthStorage
        return yield* storage.get("openai")
      }).pipe(
        Effect.provide(
          AuthStorage.LiveKeychain("gent-test", {
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
  })

  test("deleting a missing keychain item surfaces AuthStorageError (exit 44)", async () => {
    // delete must treat item-not-found as a real error — the caller asked
    // to remove something that doesn't exist, which is an invariant
    // violation worth surfacing, unlike `get` where missing is a valid
    // "no credential stored" state.
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const storage = yield* AuthStorage
        return yield* storage.delete("openai")
      }).pipe(
        Effect.provide(
          AuthStorage.LiveKeychain("gent-test", {
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
  })
})

describe("AuthStorage.LiveEncryptedFile", () => {
  test("corrupt auth files fail closed and do not get overwritten by writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gent-auth-storage-"))
    const authPath = join(dir, "auth.json.enc")
    const keyPath = join(dir, "auth.key")

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
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
        }).pipe(Effect.provide(encryptedFileLayer(authPath, keyPath))),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
