/**
 * Task tools RPC acceptance test — exercises `client.extension.query` and
 * `client.extension.mutate` through the full per-request scope path that
 * production uses (Gent.test → RpcServer → registry dispatch → handler).
 *
 * Locks the C4 transport boundary the per-commit unit tests don't cover:
 *  - mutate creates a task → query lists it → mutate updates → query confirms
 *  - bad input fails as ExtensionProtocolError (Schema rejects at the boundary)
 *  - missing mutation/query id fails as ExtensionProtocolError (NotFound mapped)
 */
import { describe, it, expect } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { textStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { setupExtension } from "@gent/core/runtime/extensions/loader"
import { TaskExtension } from "@gent/extensions/task-tools"
import { TaskCreateRef, TaskUpdateRef, TaskDeleteRef } from "@gent/extensions/task-tools/mutations"
import { TaskListRef } from "@gent/extensions/task-tools/queries"
import { Gent } from "@gent/sdk"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { e2ePreset } from "../helpers/test-preset"

const setupTaskExt = Effect.provide(
  setupExtension(
    { extension: TaskExtension, kind: "builtin", sourcePath: "builtin" },
    "/test/cwd",
    "/test/home",
  ),
  BunServices.layer,
)

describe("TaskExtension via RPC", () => {
  it.live(
    "mutate(TaskCreate) → query(TaskList) → mutate(TaskUpdate) round-trip",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupTaskExt
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          // mutate: create
          const created = (yield* client.extension.mutate({
            sessionId,
            branchId,
            extensionId: TaskCreateRef.extensionId,
            mutationId: TaskCreateRef.mutationId,
            input: { subject: "Inspect repo" },
          })) as { id: string; subject: string; status: string }
          expect(created.id).toBeDefined()
          expect(created.subject).toBe("Inspect repo")
          expect(created.status).toBe("pending")

          // query: list
          const listed = (yield* client.extension.query({
            sessionId,
            branchId,
            extensionId: TaskListRef.extensionId,
            queryId: TaskListRef.queryId,
            input: {},
          })) as ReadonlyArray<{ id: string; subject: string; status: string }>
          expect(listed).toHaveLength(1)
          expect(listed[0]?.id).toBe(created.id)

          // mutate: transition pending → in_progress
          yield* client.extension.mutate({
            sessionId,
            branchId,
            extensionId: TaskUpdateRef.extensionId,
            mutationId: TaskUpdateRef.mutationId,
            input: { taskId: created.id, status: "in_progress" },
          })

          const afterUpdate = (yield* client.extension.query({
            sessionId,
            branchId,
            extensionId: TaskListRef.extensionId,
            queryId: TaskListRef.queryId,
            input: {},
          })) as ReadonlyArray<{ id: string; status: string }>
          expect(afterUpdate[0]?.status).toBe("in_progress")

          // mutate: delete
          yield* client.extension.mutate({
            sessionId,
            branchId,
            extensionId: TaskDeleteRef.extensionId,
            mutationId: TaskDeleteRef.mutationId,
            input: { taskId: created.id },
          })
          const afterDelete = (yield* client.extension.query({
            sessionId,
            branchId,
            extensionId: TaskListRef.extensionId,
            queryId: TaskListRef.queryId,
            input: {},
          })) as ReadonlyArray<unknown>
          expect(afterDelete).toHaveLength(0)
        }),
      ),
    { timeout: 10_000 },
  )

  it.live(
    "mutate with bad input fails as ExtensionProtocolError",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupTaskExt
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          const result = yield* client.extension
            .mutate({
              sessionId,
              branchId,
              extensionId: TaskCreateRef.extensionId,
              mutationId: TaskCreateRef.mutationId,
              // subject is required String; passing wrong type forces decode failure
              input: { subject: 123 },
            })
            .pipe(Effect.flip)
          // ExtensionProtocolError is the transport boundary's tagged error
          expect(result._tag).toBe("ExtensionProtocolError")
        }),
      ),
    { timeout: 10_000 },
  )

  it.live(
    "mutate with unknown id fails as ExtensionProtocolError",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupTaskExt
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [ext] }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })

          const result = yield* client.extension
            .mutate({
              sessionId,
              branchId,
              extensionId: TaskCreateRef.extensionId,
              mutationId: "not-a-real-mutation",
              input: {},
            })
            .pipe(Effect.flip)
          expect(result._tag).toBe("ExtensionProtocolError")
        }),
      ),
    { timeout: 10_000 },
  )
})
