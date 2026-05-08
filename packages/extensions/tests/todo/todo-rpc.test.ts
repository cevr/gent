/**
 * Todo tools RPC acceptance test — exercises `client.extension.request`
 * through the full per-request scope path that
 * production uses (Gent.test → RpcServer → registry dispatch → handler).
 *
 * Locks the  transport boundary the per-commit unit tests don't cover:
 *  - request(write) creates a todo → request(read) lists it → request(write)
 *    updates → request(read) confirms
 *  - bad input fails as ExtensionProtocolError (Schema rejects at the boundary)
 *  - missing capability id fails as ExtensionProtocolError (NotFound mapped)
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { textStep } from "@gent/core-internal/debug/provider"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { TodoExtension } from "../../src/todo/index.js"
import {
  TodoCreateRequest,
  TodoDeleteRequest,
  TodoListRequest,
  TodoUpdateRequest,
} from "../../src/todo/requests.js"
import { ref } from "@gent/core/extensions/api"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { e2ePreset } from "../helpers/test-preset"

// Hoisted refs — every test reuses the same capability tokens.
const TodoCreateRef = ref(TodoCreateRequest)
const TodoDeleteRef = ref(TodoDeleteRequest)
const TodoListRef = ref(TodoListRequest)
const TodoUpdateRef = ref(TodoUpdateRequest)

describe("TodoExtension via RPC", () => {
  it.live(
    "request(TodoCreate/TodoList/TodoUpdate) round-trip",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [TodoExtension],
          })

          // request: create
          const created = (yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TodoCreateRef.extensionId,
            capabilityId: TodoCreateRef.capabilityId,
            input: { subject: "Inspect repo" },
          })) as { id: string; subject: string; status: string }
          expect(created.id).toBeDefined()
          expect(created.subject).toBe("Inspect repo")
          expect(created.status).toBe("pending")

          // request: list
          const listed = (yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TodoListRef.extensionId,
            capabilityId: TodoListRef.capabilityId,
            input: {},
          })) as ReadonlyArray<{ id: string; subject: string; status: string }>
          expect(listed).toHaveLength(1)
          expect(listed[0]?.id).toBe(created.id)

          // request: transition pending → in_progress
          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TodoUpdateRef.extensionId,
            capabilityId: TodoUpdateRef.capabilityId,
            input: { todoId: created.id, status: "in_progress" },
          })

          const afterUpdate = (yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TodoListRef.extensionId,
            capabilityId: TodoListRef.capabilityId,
            input: {},
          })) as ReadonlyArray<{ id: string; status: string }>
          expect(afterUpdate[0]?.status).toBe("in_progress")

          // request: delete
          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TodoDeleteRef.extensionId,
            capabilityId: TodoDeleteRef.capabilityId,
            input: { todoId: created.id },
          })
          const afterDelete = (yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TodoListRef.extensionId,
            capabilityId: TodoListRef.capabilityId,
            input: {},
          })) as ReadonlyArray<unknown>
          expect(afterDelete).toHaveLength(0)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "request with bad input fails as ExtensionProtocolError",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [TodoExtension],
          })

          const result = yield* Effect.exit(
            client.extension.request({
              sessionId,
              branchId,
              extensionId: TodoCreateRef.extensionId,
              capabilityId: TodoCreateRef.capabilityId,
              // subject is required String; passing wrong type forces decode failure
              input: { subject: 123 },
            }),
          )
          // ExtensionProtocolError is the transport boundary's tagged error
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure")
            expect(String(result.cause)).toContain("ExtensionProtocolError")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "request with unknown id fails as ExtensionProtocolError",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [TodoExtension],
          })

          const result = yield* Effect.exit(
            client.extension.request({
              sessionId,
              branchId,
              extensionId: TodoCreateRef.extensionId,
              capabilityId: "not-a-real-capability",
              input: {},
            }),
          )
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure")
            expect(String(result.cause)).toContain("ExtensionProtocolError")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "request dispatch does not require intent metadata",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [TodoExtension],
          })

          const result = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId: TodoCreateRef.extensionId,
            capabilityId: TodoCreateRef.capabilityId,
            input: { subject: "Inspect repo" },
          })

          expect((result as { subject: string }).subject).toBe("Inspect repo")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )
})
