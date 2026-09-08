import { expect, it } from "effect-bun-test"
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schema,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import * as Prompt from "effect/unstable/ai/Prompt"
import { ExtensionContext, tool } from "@gent/core/extensions/api"
import { LoadedArtifactIdentity, type LoadedExtension } from "@gent/core-internal/domain/extension"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import { Message, dateFromMillis } from "@gent/core-internal/domain/message"
import { makeAmbientExtensionHostContextProvider } from "@gent/core-internal/runtime/make-extension-host-context"
import {
  makeCellToolHost,
  resumeCellToolOperation,
} from "@gent/core-internal/runtime/code-cell/cell-tool-host"
import { ApprovalService } from "@gent/core-internal/runtime/approval-service"
import { recoverCellExecution } from "@gent/core-internal/runtime/code-cell/cell-recovery"
import { ModelContextLedger } from "@gent/core-internal/runtime/model-context-ledger"
import { CellResponse } from "@gent/core-internal/runtime/code-cell/cell-protocol"
import { SessionProfileCache } from "@gent/core-internal/runtime/session-profile"
import { CellExecutionStorage } from "@gent/core-internal/storage/cell-execution-storage"
import { CellToolOperationStorage } from "@gent/core-internal/storage/cell-tool-operation-storage"
import { MessageStorage } from "@gent/core-internal/storage/message-storage"
import { InteractionStorage } from "@gent/core-internal/storage/interaction-storage"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import { createE2ELayer } from "@gent/core-internal/test-utils/e2e-layer"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { captureCurrentToolBinding } from "@gent/core-internal/runtime/agent/tool-binding-resolution"
import { runAgentLoopTurnProfile } from "@gent/core-internal/runtime/agent/agent-loop.turn-profile"
import type { ResolvedToolCapability } from "@gent/core-internal/runtime/agent/tool-runner"

const cell = {
  sessionId: SessionId.make("recorded-host-session"),
  branchId: BranchId.make("recorded-host-branch"),
  assistantMessageId: MessageId.make("recorded-host-message"),
  toolCallId: ToolCallId.make("recorded-host-call"),
}
const request = (operationId: string, name: string) =>
  CellResponse.cases.HostCall.make({
    cellId: "1",
    operationId,
    name,
    input: { valid: true },
  })

const prepareCell = Effect.gen(function* () {
  yield* ensureStorageParents(cell)
  yield* (yield* MessageStorage).createMessage(
    Message.cases.regular.make({
      id: cell.assistantMessageId,
      sessionId: cell.sessionId,
      branchId: cell.branchId,
      role: "assistant",
      createdAt: dateFromMillis(0),
      parts: [
        Prompt.toolCallPart({
          id: cell.toolCallId,
          name: "cell",
          params: { code: "1" },
          providerExecuted: false,
        }),
      ],
    }),
  )
  yield* (yield* CellExecutionStorage).claim(cell)
})

const currentHostParams = Effect.gen(function* () {
  const profile = yield* (yield* SessionProfileCache).resolve("/tmp")
  if (Predicate.isUndefined(profile.publication))
    return yield* Effect.die("Missing live publication")
  const hostProvider = yield* makeAmbientExtensionHostContextProvider({
    extensionRegistry: profile.registryService,
  })
  const turnProfile = {
    turnPublication: profile.publication,
    turnExtensionRegistry: profile.registryService,
    turnDriverRegistry: profile.driverRegistryService,
    turnPermission: profile.permissionService,
    turnBaseSections: profile.baseSections,
    turnHostCtx: hostProvider.forRun(cell),
  }
  const toolBindings = yield* runAgentLoopTurnProfile(turnProfile)(
    Effect.gen(function* () {
      const bindings = new Map<string, ResolvedToolCapability>()
      for (const name of profile.registryService.getResolved().modelCapabilities.keys()) {
        const binding = yield* captureCurrentToolBinding({
          sessionId: cell.sessionId,
          toolName: name,
          publication: turnProfile.turnPublication,
        })
        if (Option.isSome(binding)) bindings.set(name, binding.value)
      }
      return bindings
    }),
  )
  return { cell, profile: turnProfile, toolBindings, ledger: yield* ModelContextLedger.make }
})

it.scopedLive(
  "records real host results once and preserves approval and interrupted outcomes",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const approvalCalls = yield* Ref.make(0)
      const started = yield* Deferred.make<boolean>()
      const finalized = yield* Deferred.make<boolean>()
      const extensions: ReadonlyArray<LoadedExtension> = [
        {
          manifest: { id: ExtensionId.make("recorded-host") },
          scope: "builtin",
          sourcePath: "recorded-host",
          artifactIdentity: LoadedArtifactIdentity.make("recorded-host-source"),
          contributions: {
            tools: [
              tool({
                id: "count",
                description: "Count execution",
                params: Schema.Struct({ valid: Schema.Boolean }),
                output: Schema.Finite,
                execute: () => Ref.updateAndGet(calls, (count) => count + 1),
              }),
              tool({
                id: "approve",
                description: "Request approval",
                params: Schema.Struct({}),
                output: Schema.Boolean,
                execute: () =>
                  Effect.gen(function* () {
                    yield* Ref.update(approvalCalls, (count) => count + 1)
                    const ctx = yield* ExtensionContext
                    return (yield* ctx.Interaction.approve({ text: "Allow?" })).approved
                  }),
              }),
              tool({
                id: "interrupt",
                description: "Wait after effect",
                params: Schema.Struct({}),
                output: Schema.Boolean,
                execute: () =>
                  Ref.update(calls, (count) => count + 1).pipe(
                    Effect.andThen(Deferred.succeed(started, true)),
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(finalized, true)),
                  ),
              }),
            ],
          },
        },
      ]
      const context = yield* Layer.build(
        createE2ELayer({
          agents: [],
          extensionInputs: [],
          extensions,
          providerLayer: LanguageModelLayers.debug(),
          durableApproval: true,
        }),
      )
      yield* Effect.gen(function* () {
        yield* prepareCell
        const hostParams = yield* currentHostParams
        const host = makeCellToolHost(hostParams)
        expect(
          (yield* recoverCellExecution({
            ...hostParams,
            cell: { ...cell, branchId: BranchId.make("other") },
          }).pipe(Effect.flip))._tag,
        ).toBe("CellEvaluationError")
        expect(yield* host.call(request("1", "count"))).toBe(1)
        expect(yield* host.call(request("1", "count"))).toBe(1)
        expect(yield* Ref.get(calls)).toBe(1)
        const invalid = CellResponse.cases.HostCall.make({
          ...request("invalid", "count"),
          input: [],
        })
        expect((yield* host.call(invalid).pipe(Effect.flip))._tag).toBe("CellEvaluationError")
        expect((yield* host.call(invalid).pipe(Effect.flip))._tag).toBe("CellEvaluationError")
        const operations = yield* CellToolOperationStorage
        const failed = yield* operations.get({ cell, operationId: "invalid" })
        expect(failed.state._tag).toBe("Completed")
        if (failed.state._tag === "Completed") expect(failed.state.result.isFailure).toBe(true)
        expect(yield* Ref.get(calls)).toBe(1)
        const pending = yield* host.call(request("2", "approve")).pipe(Effect.flip)
        expect(pending._tag).toBe("CellToolCallSuspended")
        expect((yield* operations.get({ cell, operationId: "2" })).state._tag).toBe("Waiting")
        expect(yield* (yield* InteractionStorage).listPending(cell)).toHaveLength(1)
        if (pending._tag !== "CellToolCallSuspended") return yield* Effect.die(pending)
        const undecided = yield* recoverCellExecution(hostParams).pipe(Effect.flip)
        expect(undecided._tag).toBe("CellToolCallSuspended")
        if (undecided._tag === "CellToolCallSuspended")
          expect(undecided.pending.requestId).toBe(pending.pending.requestId)
        expect(yield* Ref.get(approvalCalls)).toBe(1)
        const resumeParams = {
          ...hostParams,
          operationId: "2",
          requestId: pending.pending.requestId,
        }
        expect(
          (yield* resumeCellToolOperation({
            ...resumeParams,
            requestId: InteractionRequestId.make("wrong"),
          }).pipe(Effect.flip))._tag,
        ).toBe("StorageError")
        expect(yield* Ref.get(approvalCalls)).toBe(1)
        const approval = yield* ApprovalService
        yield* approval.storeResolution(pending.pending.requestId, { approved: false })
        const attempts = yield* Effect.all(
          [
            resumeCellToolOperation(resumeParams).pipe(Effect.exit),
            resumeCellToolOperation(resumeParams).pipe(Effect.exit),
          ],
          { concurrency: 2 },
        )
        expect(attempts.filter(Exit.isSuccess)).toHaveLength(1)
        const success = attempts.find(Exit.isSuccess)
        if (Predicate.isUndefined(success)) return yield* Effect.die("No successful resume")
        const resumed = success.value
        expect(resumed.result).toBe(false)
        expect(resumed.isFailure).toBe(false)
        expect(resumed.id).toBe(pending.toolCallId)
        expect((yield* operations.get({ cell, operationId: "2" })).state._tag).toBe("Completed")
        expect((yield* resumeCellToolOperation(resumeParams).pipe(Effect.flip))._tag).toBe(
          "StorageError",
        )
        expect(yield* Ref.get(approvalCalls)).toBe(2)
        expect((yield* (yield* CellExecutionStorage).claim(cell))._tag).toBe("Incomplete")
        const running = yield* host.call(request("3", "interrupt")).pipe(Effect.forkScoped)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(running)
        yield* Deferred.await(finalized)
        const unknown = yield* host.call(request("3", "interrupt")).pipe(Effect.flip)
        expect(unknown._tag).toBe("CellEvaluationError")
        if (unknown._tag === "CellEvaluationError")
          expect(unknown.message).toContain("not executed again")
        expect(yield* Ref.get(calls)).toBe(2)
        const recovered = yield* recoverCellExecution(hostParams)
        expect(recovered.isFailure).toBe(true)
        expect(recovered.result).toMatchObject({
          stateLost: true,
          operations: expect.arrayContaining([
            {
              _tag: "Unknown",
              operationId: "3",
              toolCallId: (yield* operations.get({ cell, operationId: "3" })).toolCallId,
              toolName: "interrupt",
            },
          ]),
        })
        expect(yield* recoverCellExecution(hostParams)).toEqual(recovered)
        expect(yield* Ref.get(calls)).toBe(2)
      }).pipe(Effect.provideContext(context))
    }).pipe(Effect.timeout("15 seconds")),
  20000,
)

it.scopedLive(
  "resumes an approved operation after reopen and rejects changed source before admission",
  () =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()
      const storagePath = (yield* Path.Path).join(directory, "gent.db")
      const calls = yield* Ref.make(0)
      const extension = (revision: string): LoadedExtension => ({
        manifest: { id: ExtensionId.make("restart-host") },
        scope: "builtin",
        sourcePath: "restart-host",
        artifactIdentity: LoadedArtifactIdentity.make(revision),
        contributions: {
          tools: [
            tool({
              id: "approve",
              description: "Approve saved input",
              params: Schema.Struct({ valid: Schema.Boolean }),
              output: Schema.Boolean,
              execute: ({ valid }) =>
                Effect.gen(function* () {
                  yield* Ref.update(calls, (count) => count + 1)
                  const ctx = yield* ExtensionContext
                  return (
                    (yield* ctx.Interaction.approve({ text: "Allow saved input?" })).approved &&
                    valid
                  )
                }),
            }),
          ],
        },
      })
      const layer = (revision: string) =>
        createE2ELayer({
          agents: [],
          extensionInputs: [],
          extensions: [extension(revision)],
          providerLayer: LanguageModelLayers.debug(),
          durableApproval: true,
          storagePath,
        })
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer("original"))
          return yield* Effect.gen(function* () {
            yield* prepareCell
            const host = makeCellToolHost(yield* currentHostParams)
            const pending = yield* host.call(request("1", "approve")).pipe(Effect.flip)
            if (pending._tag !== "CellToolCallSuspended") return yield* Effect.die(pending)
            yield* (yield* ApprovalService).storeResolution(pending.pending.requestId, {
              approved: true,
            })
            return pending
          }).pipe(Effect.provideContext(context))
        }),
      )
      const next = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer("original"))
          return yield* Effect.gen(function* () {
            const hostParams = yield* currentHostParams
            const result = yield* resumeCellToolOperation({
              ...hostParams,
              operationId: "1",
              requestId: first.pending.requestId,
            })
            expect(result.result).toBe(true)
            expect(result.id).toBe(first.toolCallId)
            expect(yield* Ref.get(calls)).toBe(2)
            expect((yield* (yield* CellExecutionStorage).claim(cell))._tag).toBe("Incomplete")
            const pending = yield* makeCellToolHost(hostParams)
              .call(request("2", "approve"))
              .pipe(Effect.flip)
            if (pending._tag !== "CellToolCallSuspended") return yield* Effect.die(pending)
            yield* (yield* ApprovalService).storeResolution(pending.pending.requestId, {
              approved: true,
            })
            return pending
          }).pipe(Effect.provideContext(context))
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer("changed"))
          yield* Effect.gen(function* () {
            const mismatch = yield* resumeCellToolOperation({
              ...(yield* currentHostParams),
              operationId: "2",
              requestId: next.pending.requestId,
            }).pipe(Effect.flip)
            expect(mismatch._tag).toBe("ToolBindingReplayError")
            if (mismatch._tag === "ToolBindingReplayError")
              expect(mismatch.reason).toBe("SourceMismatch")
            expect(
              (yield* (yield* CellToolOperationStorage).get({ cell, operationId: "2" })).state._tag,
            ).toBe("Waiting")
            expect(yield* Ref.get(calls)).toBe(3)
          }).pipe(Effect.provideContext(context))
        }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer("original"))
          yield* Effect.gen(function* () {
            const hostParams = yield* currentHostParams
            const recovered = yield* recoverCellExecution(hostParams)
            expect(recovered.isFailure).toBe(true)
            expect(recovered.result).toMatchObject({ stateLost: true })
            expect(yield* Ref.get(calls)).toBe(4)
            expect(
              (yield* (yield* CellToolOperationStorage).listForCell(cell)).map(
                ({ operation }) => operation.state._tag,
              ),
            ).toEqual(["Completed", "Completed"])
            expect(yield* recoverCellExecution(hostParams)).toEqual(recovered)
            expect(yield* Ref.get(calls)).toBe(4)
          }).pipe(Effect.provideContext(context))
        }),
      )
    }).pipe(Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
  25000,
)
