import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Ref, Stream } from "effect"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../extensions/helpers/test-preset"

const makeClient = (reply = "ok") =>
  Effect.gen(function* () {
    const { layer: providerLayer } = yield* createSequenceProvider([textStep(reply)])
    return yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
  })

const collectRuntime = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const values = yield* Ref.make<A[]>([])
    const ready = yield* Deferred.make<void>()

    yield* stream.pipe(
      Stream.runForEach((value) =>
        Ref.update(values, (current) => [...current, value]).pipe(
          Effect.andThen(Deferred.succeed(ready, undefined).pipe(Effect.ignore)),
        ),
      ),
      Effect.forkScoped,
    )

    yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
    return values
  })

describe("session queries", () => {
  it.live(
    "getSessionSnapshot matches the persisted conversation and public watchRuntime settles on the same runtime state",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userText = "snapshot request"
          const assistantText = "snapshot reply"
          const { client } = yield* makeClient(assistantText)
          const created = yield* client.session.create({ cwd: process.cwd() })

          const runtime = yield* collectRuntime(
            client.session.watchRuntime({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: userText,
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === assistantText),
              ),
            5_000,
            "session snapshot assistant reply",
          )

          const observedStates = yield* waitFor(
            Ref.get(runtime),
            (current) => current.length >= 2 && current[current.length - 1]?._tag === "Idle",
            5_000,
            "watchRuntime settles on idle after the completed turn",
          )

          expect(observedStates.length).toBeGreaterThanOrEqual(2)
          expect(snapshot.runtime._tag).toBe("Idle")
          expect(observedStates[observedStates.length - 1]?._tag).toBe(snapshot.runtime._tag)
          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "user" &&
                message.parts.some((part) => part.type === "text" && part.text === userText),
            ),
          ).toBe(true)
          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          ).toBe(true)
        }),
      ),
  )

  it.live("getChildSessions returns only direct descendants", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const root = yield* client.session.create({ name: "Root", cwd: process.cwd() })
        const childA = yield* client.session.create({
          name: "Child A",
          cwd: process.cwd(),
          parentSessionId: root.sessionId,
          parentBranchId: root.branchId,
        })
        yield* client.session.create({
          name: "Grandchild",
          cwd: process.cwd(),
          parentSessionId: childA.sessionId,
          parentBranchId: childA.branchId,
        })
        yield* client.session.create({
          name: "Child B",
          cwd: process.cwd(),
          parentSessionId: root.sessionId,
          parentBranchId: root.branchId,
        })

        const children = yield* client.session.getChildren({ parentSessionId: root.sessionId })

        expect(children).toHaveLength(2)
        expect(children.every((child) => child.parentSessionId === root.sessionId)).toBe(true)
      }),
    ),
  )

  it.live("getSessionTree returns the recursive session hierarchy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const root = yield* client.session.create({ name: "Root", cwd: process.cwd() })
        const child = yield* client.session.create({
          name: "Child",
          cwd: process.cwd(),
          parentSessionId: root.sessionId,
          parentBranchId: root.branchId,
        })
        yield* client.session.create({
          name: "Grandchild",
          cwd: process.cwd(),
          parentSessionId: child.sessionId,
          parentBranchId: child.branchId,
        })

        const tree = yield* client.session.getTree({ sessionId: root.sessionId })

        expect(tree.id).toBe(root.sessionId)
        expect(tree.children).toHaveLength(1)
        expect(tree.children[0]?.id).toBe(child.sessionId)
        expect(tree.children[0]?.children).toHaveLength(1)
      }),
    ),
  )

  it.live("createSession rejects a missing parent session through the public API", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const result = yield* Effect.result(
          client.session.create({
            name: "Orphan",
            cwd: process.cwd(),
            parentSessionId: SessionId.make("nonexistent"),
          }),
        )

        expect(result._tag).toBe("Failure")
      }),
    ),
  )

  it.live("createSession rejects parent branch without parent session through the public API", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const result = yield* Effect.result(
          client.session.create({
            name: "Dangling branch parent",
            cwd: process.cwd(),
            parentBranchId: BranchId.make("dangling-parent-branch"),
          }),
        )

        expect(result._tag).toBe("Failure")
      }),
    ),
  )
})
