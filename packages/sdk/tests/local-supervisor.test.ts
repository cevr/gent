import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Queue } from "effect"
import * as path from "node:path"
import { Gent } from "../src/index"
import { startLocalSupervisor } from "../src/local-supervisor"
import { GentConnectionError } from "@gent/core/server/transport-contract.js"
import { BranchId, SessionId } from "@gent/core/domain/ids.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import { GentRpcs } from "@gent/core/server/rpcs.js"
import { baseLocalLayer as _baseLocalLayer } from "@gent/core/test-utils/in-process-layer.js"
import { AllBuiltinAgents } from "@gent/extensions/all-agents.js"
import { GitReader } from "@gent/extensions/librarian/git-reader.js"

const baseLocalLayer = () =>
  _baseLocalLayer({ agents: AllBuiltinAgents, extraLayers: [GitReader.Test] })
import { RpcTest } from "effect/unstable/rpc"

const repoRoot = path.resolve(import.meta.dir, "../../..")

describe("local supervisor", () => {
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

  test("disconnected effect methods and stream queue overloads fail with connection errors", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* startLocalSupervisor(
            () => Effect.fail(new Error("boot boom")),
            (error) =>
              new GentConnectionError({
                message:
                  typeof error === "object" && error !== null && "message" in error
                    ? String((error as { readonly message: unknown }).message)
                    : String(error),
              }),
          )

          yield* supervisor.lifecycle.waitForReady

          const createError = yield* Effect.flip(
            supervisor.client.session.create({ cwd: repoRoot }),
          )

          expect(createError).toBeInstanceOf(GentConnectionError)
          expect(createError.message).toBe("boot boom")

          const queue = yield* supervisor.client.session.events(
            { sessionId: SessionId.make("session-test") },
            { asQueue: true },
          )
          const error = yield* Effect.flip(Queue.take(queue))

          expect(error).toBeInstanceOf(GentConnectionError)
          expect(error.message).toBe("boot boom")

          const runtimeQueue = yield* supervisor.client.session.watchRuntime(
            {
              sessionId: SessionId.make("session-test"),
              branchId: BranchId.make("branch-test"),
            },
            { asQueue: true },
          )
          const runtimeError = yield* Effect.flip(Queue.take(runtimeQueue))

          expect(runtimeError).toBeInstanceOf(GentConnectionError)
          expect(runtimeError.message).toBe("boot boom")
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
})
