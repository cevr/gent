import { expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { tool } from "@gent/core/extensions/api"
import { EventStore } from "@gent/core-internal/domain/event"
import { EventPublisherLive } from "@gent/core-internal/domain/event-publisher"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  SessionId,
  ToolCallId,
} from "@gent/core-internal/domain/ids"
import { InteractionPendingError } from "@gent/core-internal/domain/interaction-request"
import { Permission, PermissionRule } from "@gent/core-internal/domain/permission"
import { provideCurrentHostCtx } from "@gent/core-internal/runtime/agent/current-extension-host-context"
import {
  ToolRunner,
  type ResolvedToolCapability,
} from "@gent/core-internal/runtime/agent/tool-runner"
import {
  executeBoundCellTool,
  cellToolResultValue,
} from "@gent/core-internal/runtime/code-cell/cell-tool-call"
import { CellResponse } from "@gent/core-internal/runtime/code-cell/cell-protocol"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  ExtensionRegistry,
  resolveExtensions,
} from "@gent/core-internal/runtime/extensions/registry"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"

const extensionId = ExtensionId.make("cell-test")
const runCellToolCall = (params: Parameters<typeof executeBoundCellTool>[0]) =>
  executeBoundCellTool(params).pipe(Effect.flatMap(cellToolResultValue))
const sessionId = SessionId.make("cell-session")
const branchId = BranchId.make("cell-branch")
const toolCallId = ToolCallId.make("cell-inner-operation")
const request = CellResponse.cases.HostCall.make({
  cellId: "1",
  operationId: "1",
  name: "echo",
  input: { text: "hello" },
})
const host = testToolContext({ sessionId, branchId, toolCallId })
const base = Layer.mergeAll(
  BunServices.layer,
  ToolRunner.Live,
  EventPublisherLive.pipe(Layer.provide(EventStore.Memory)),
)

it.scopedLive(
  "uses the exact selected capability and still enforces permission and input schema",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const selected = tool({
        id: "echo",
        description: "Selected echo",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: ({ text }) =>
          Ref.update(calls, (count) => count + 1).pipe(Effect.as(`selected:${text}`)),
      })
      const replacement = tool({
        id: "echo",
        description: "Replacement echo",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: () => Effect.die("Must not resolve the replacement by name"),
      })
      const registry = ExtensionRegistry.fromResolved(
        resolveExtensions([
          {
            manifest: { id: extensionId },
            scope: "builtin",
            sourcePath: "cell-test",
            contributions: { tools: [replacement] },
          },
        ]),
      )
      const binding: Option.Option<ResolvedToolCapability> = Option.some({
        extensionId,
        capability: selected,
        origin: "static",
      })
      const layer = Layer.mergeAll(base, registry, Permission.Live([]))
      yield* Effect.gen(function* () {
        expect(yield* runCellToolCall({ request, toolCallId, binding })).toBe("selected:hello")
        const invalid = yield* runCellToolCall({
          request: CellResponse.cases.HostCall.make({ ...request, input: { text: 1 } }),
          toolCallId,
          binding,
        }).pipe(Effect.flip)
        expect(invalid._tag).toBe("CellEvaluationError")
        const denyContext = yield* Layer.build(
          Permission.Live([new PermissionRule({ tool: "echo", action: "deny" })]),
        )
        const denied = yield* runCellToolCall({ request, toolCallId, binding }).pipe(
          Effect.provideContext(denyContext),
          Effect.flip,
        )
        expect(denied._tag).toBe("CellEvaluationError")
        if (denied._tag === "CellEvaluationError")
          expect(denied.message).toContain("Permission denied")
        const mismatch = yield* runCellToolCall({
          request: CellResponse.cases.HostCall.make({ ...request, name: "other" }),
          toolCallId,
          binding,
        }).pipe(Effect.flip)
        expect(mismatch._tag).toBe("CellEvaluationError")
        const missing = yield* runCellToolCall({
          request,
          toolCallId,
          binding: Option.none(),
        }).pipe(Effect.flip)
        expect(missing._tag).toBe("CellEvaluationError")
        if (missing._tag === "CellEvaluationError")
          expect(missing.message).toContain("Unknown tool")
        expect(yield* Ref.get(calls)).toBe(1)
      }).pipe(provideCurrentHostCtx(host), Effect.provideContext(yield* Layer.build(layer)))
    }),
)

it.scopedLive("preserves the pending request and host operation identity", () =>
  Effect.gen(function* () {
    const pending = new InteractionPendingError({
      requestId: InteractionRequestId.make("cell-approval"),
      sessionId,
      branchId,
    })
    const selected = tool({
      id: "echo",
      description: "Approval tool",
      params: Schema.Struct({ text: Schema.String }),
      output: Schema.String,
      execute: () => Effect.fail(pending),
    })
    const registry = ExtensionRegistry.fromResolved(
      resolveExtensions([
        {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "cell-test",
          contributions: { tools: [selected] },
        },
      ]),
    )
    const result = yield* runCellToolCall({
      request,
      toolCallId,
      binding: Option.some({ extensionId, capability: selected, origin: "static" }),
    }).pipe(
      provideCurrentHostCtx(host),
      Effect.provideContext(
        yield* Layer.build(Layer.mergeAll(base, registry, Permission.Live([]))),
      ),
      Effect.flip,
    )
    expect(result).toMatchObject({
      _tag: "CellToolCallSuspended",
      operationId: request.operationId,
      toolCallId,
      pending,
    })
  }),
)

it.effect(
  "drops undefined optional fields from a tool result before it crosses the cell pipe",
  () =>
    Effect.gen(function* () {
      // Schema-encoded results keep `undefined` for optional fields such as the
      // delegate metadata session id of an ephemeral child. That is not JSON.
      const Metadata = Schema.Struct({
        sessionId: Schema.optional(Schema.String),
        agentName: Schema.String,
      })
      const metadata = yield* Schema.encodeEffect(Metadata)({
        sessionId: Option.getOrUndefined(Option.none<string>()),
        agentName: "main",
      })
      const result = Prompt.toolResultPart({
        id: toolCallId,
        name: "delegate",
        isFailure: false,
        providerExecuted: false,
        result: { output: "pong", metadata },
      })
      const value = yield* cellToolResultValue(result)
      expect(value).toEqual({ output: "pong", metadata: { agentName: "main" } })
    }),
)
