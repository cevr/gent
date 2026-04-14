import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Gent } from "../src/index"
import { startLocalSupervisor } from "../src/local-supervisor"
import { GentConnectionError } from "@gent/core/server/transport-contract.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import { GentRpcs } from "@gent/core/server/rpcs.js"
import { baseLocalLayer } from "@gent/core/test-utils/in-process-layer.js"
import { RpcTest } from "effect/unstable/rpc"

const tempDirs: string[] = []
const repoRoot = path.resolve(import.meta.dir, "../../..")

const makeTempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gent-local-supervisor-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe("Gent.local", () => {
  test("does not await the first local child boot before returning control", async () => {
    const gate = await Effect.runPromise(Deferred.make<void>())

    await Promise.race([
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* startLocalSupervisor(
              () => Deferred.await(gate).pipe(Effect.andThen(Effect.die("unreachable"))),
              (error) =>
                new GentConnectionError({
                  message:
                    typeof error === "object" && error !== null && "message" in error
                      ? String((error as { readonly message: unknown }).message)
                      : String(error),
                }),
            )

            expect(supervisor.lifecycle.getState()).toEqual({
              _tag: "connecting",
            })
          }),
        ),
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("startLocalSupervisor blocked")), 200)
      }),
    ])
  })

  test("returns a disconnected lifecycle when the first local runtime boot fails", async () => {
    let attempts = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* startLocalSupervisor(
            (scope) =>
              Effect.gen(function* () {
                attempts += 1
                if (attempts === 1) {
                  return yield* Effect.fail(new Error("boot boom"))
                }

                const handlers = yield* Layer.buildWithScope(
                  Layer.provide(RpcHandlersLive, baseLocalLayer()),
                  scope,
                )

                return yield* RpcTest.makeClient(GentRpcs).pipe(Effect.provide(handlers))
              }),
            (error) =>
              new GentConnectionError({
                message:
                  typeof error === "object" && error !== null && "message" in error
                    ? String((error as { readonly message: unknown }).message)
                    : String(error),
              }),
          )

          expect(supervisor.lifecycle.getState()).toEqual({
            _tag: "connecting",
          })

          yield* supervisor.lifecycle.waitForReady

          expect(supervisor.lifecycle.getState()).toEqual({
            _tag: "disconnected",
            reason: "boot boom",
          })

          yield* supervisor.lifecycle.restart
          yield* supervisor.lifecycle.waitForReady

          expect(supervisor.lifecycle.getState()).toEqual({
            _tag: "connected",
            generation: 1,
          })
        }),
      ),
    )
  })

  test("Gent.server(memory) + Gent.client creates a working in-process client", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Gent.server({
            cwd: repoRoot,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })
          const bundle = yield* Gent.client(server)

          expect(server._tag).toBe("owned")

          yield* bundle.runtime.lifecycle.waitForReady

          const created = yield* bundle.client.session.create({ cwd: repoRoot })
          expect(created.sessionId).toBeDefined()
          expect(bundle.runtime.lifecycle.getState()).toEqual({
            _tag: "connected",
            generation: 0,
          })
        }),
      ),
    )
  })

  test("restarts the in-process runtime and keeps the client facade alive", async () => {
    const dataDir = makeTempDir()
    const states: string[] = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bundle = yield* Gent.local({
            cwd: repoRoot,
            home: dataDir,
            dataDir,
            persistenceMode: "memory",
            providerMode: "debug-scripted",
          })

          const unsubscribe = bundle.runtime.lifecycle.subscribe((state) => {
            states.push(state._tag)
          })

          yield* bundle.runtime.lifecycle.waitForReady

          const createdBeforeRestart = yield* bundle.client.session.create({ cwd: repoRoot })
          expect(createdBeforeRestart.sessionId).toBeDefined()
          expect(bundle.runtime.lifecycle.getState()).toEqual({
            _tag: "connected",
            generation: 0,
          })

          yield* bundle.runtime.lifecycle.restart
          yield* bundle.runtime.lifecycle.waitForReady

          const createdAfterRestart = yield* bundle.client.session.create({ cwd: repoRoot })
          expect(createdAfterRestart.sessionId).toBeDefined()
          expect(bundle.runtime.lifecycle.getState()).toEqual({
            _tag: "connected",
            generation: 1,
          })

          unsubscribe()
        }),
      ),
    )

    expect(states).toContain("connected")
    expect(states).toContain("reconnecting")
  })
})
