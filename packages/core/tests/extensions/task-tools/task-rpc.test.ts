/**
 * Task tools RPC acceptance test — exercises `client.extension.request`
 * through the full per-request scope path that
 * production uses (Gent.test → RpcServer → registry dispatch → handler).
 *
 * Locks the C4 transport boundary the per-commit unit tests don't cover:
 *  - request(write) creates a task → request(read) lists it → request(write)
 *    updates → request(read) confirms
 *  - bad input fails as ExtensionProtocolError (Schema rejects at the boundary)
 *  - missing capability id fails as ExtensionProtocolError (NotFound mapped)
 */
import { describe, it, expect } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { textStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { setupExtension } from "../../../src/runtime/extensions/loader"
import { TaskExtension } from "@gent/extensions/task-tools"
import {
  TaskCreateRequest,
  TaskDeleteRequest,
  TaskListRequest,
  TaskUpdateRequest,
} from "@gent/extensions/task-tools/requests"
import { ref } from "@gent/core/extensions/api"
import { createRpcHarness } from "@gent/core/test-utils/rpc-harness"
import { e2ePreset } from "../helpers/test-preset"

const setupTaskExt = Effect.provide(
  setupExtension(
    { extension: TaskExtension, scope: "builtin", sourcePath: "builtin" },
    "/test/cwd",
    "/test/home",
  ),
  BunServices.layer,
)

// Hoisted refs — every test reuses the same capability tokens.
const TaskCreateRef = ref(TaskCreateRequest)
const TaskDeleteRef = ref(TaskDeleteRequest)
const TaskListRef = ref(TaskListRequest)
const TaskUpdateRef = ref(TaskUpdateRequest)

describe("TaskExtension via RPC", () => {
  it.live(
    "request(TaskCreate/TaskList/TaskUpdate) round-trip",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupTaskExt
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
          })

          // request: create
          const created = (yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TaskCreateRef.extensionId,
            capabilityId: TaskCreateRef.capabilityId,
            intent: TaskCreateRef.intent,
            input: { subject: "Inspect repo" },
          })) as { id: string; subject: string; status: string }
          expect(created.id).toBeDefined()
          expect(created.subject).toBe("Inspect repo")
          expect(created.status).toBe("pending")

          // request: list
          const listed = (yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TaskListRef.extensionId,
            capabilityId: TaskListRef.capabilityId,
            intent: TaskListRef.intent,
            input: {},
          })) as ReadonlyArray<{ id: string; subject: string; status: string }>
          expect(listed).toHaveLength(1)
          expect(listed[0]?.id).toBe(created.id)

          // request: transition pending → in_progress
          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TaskUpdateRef.extensionId,
            capabilityId: TaskUpdateRef.capabilityId,
            intent: TaskUpdateRef.intent,
            input: { taskId: created.id, status: "in_progress" },
          })

          const afterUpdate = (yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TaskListRef.extensionId,
            capabilityId: TaskListRef.capabilityId,
            intent: TaskListRef.intent,
            input: {},
          })) as ReadonlyArray<{ id: string; status: string }>
          expect(afterUpdate[0]?.status).toBe("in_progress")

          // request: delete
          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TaskDeleteRef.extensionId,
            capabilityId: TaskDeleteRef.capabilityId,
            intent: TaskDeleteRef.intent,
            input: { taskId: created.id },
          })
          const afterDelete = (yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TaskListRef.extensionId,
            capabilityId: TaskListRef.capabilityId,
            intent: TaskListRef.intent,
            input: {},
          })) as ReadonlyArray<unknown>
          expect(afterDelete).toHaveLength(0)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    { timeout: 10_000 },
  )

  it.live(
    "request with bad input fails as ExtensionProtocolError",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupTaskExt
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
          })

          const result = yield* client.extension
            .request({
              sessionId,
              branchId,
              extensionId: TaskCreateRef.extensionId,
              capabilityId: TaskCreateRef.capabilityId,
              intent: TaskCreateRef.intent,
              // subject is required String; passing wrong type forces decode failure
              input: { subject: 123 },
            })
            .pipe(Effect.flip)
          // ExtensionProtocolError is the transport boundary's tagged error
          expect(result._tag).toBe("ExtensionProtocolError")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    { timeout: 10_000 },
  )

  it.live(
    "request with unknown id fails as ExtensionProtocolError",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupTaskExt
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
          })

          const result = yield* client.extension
            .request({
              sessionId,
              branchId,
              extensionId: TaskCreateRef.extensionId,
              capabilityId: "not-a-real-capability",
              intent: "write",
              input: {},
            })
            .pipe(Effect.flip)
          expect(result._tag).toBe("ExtensionProtocolError")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    { timeout: 10_000 },
  )

  it.live(
    "request with mismatched intent fails as ExtensionProtocolError",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ext = yield* setupTaskExt
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
          })

          const result = yield* client.extension
            .request({
              sessionId,
              branchId,
              extensionId: TaskCreateRef.extensionId,
              capabilityId: TaskCreateRef.capabilityId,
              intent: "read",
              input: { subject: "Inspect repo" },
            })
            .pipe(Effect.flip)

          expect(result._tag).toBe("ExtensionProtocolError")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    { timeout: 10_000 },
  )
})
