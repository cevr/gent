import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthStorage } from "@gent/core/domain/auth-storage"

const encryptedFileLayer = (authPath: string, keyPath: string) =>
  AuthStorage.LiveEncryptedFile(authPath, keyPath).pipe(Layer.provide(BunServices.layer))

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
