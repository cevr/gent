import { Context, Effect, Layer, Schema } from "effect"
import { type ToolContext, type AnyToolDefinition, type ToolDefinition } from "../../domain/tool.js"
import { ExtensionRegistry, type ExtensionRegistryService } from "../extensions/registry.js"
import {
  ExtensionStateRuntime,
  type ExtensionStateRuntimeService,
} from "../extensions/state-runtime.js"
import { RuntimePlatform } from "../runtime-platform.js"
import { ToolResultPart } from "../../domain/message.js"
import { Permission } from "../../domain/permission.js"
import { InteractionPendingError } from "../../domain/interaction-request.js"
import { ApprovalService } from "../approval-service.js"
import { formatSchemaError } from "../format-schema-error"
import {
  withWideEvent,
  WideEvent,
  toolBoundary,
  ToolError,
  ToolWarning,
} from "../wide-event-boundary"
import {
  makeExtensionHostContext,
  type MakeExtensionHostContextDeps,
} from "../make-extension-host-context.js"
import { AgentRunnerService } from "../../domain/agent.js"
import { PromptPresenter } from "../../domain/prompt-presenter.js"
import { ExtensionTurnControl } from "../extensions/turn-control.js"
import { Storage } from "../../storage/sqlite-storage.js"
import { SearchStorage } from "../../storage/search-storage.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import type { SessionId, ToolCallId } from "../../domain/ids.js"
import type { StorageService } from "../../storage/sqlite-storage.js"
import type { Option } from "effect"

/** Resolve session cwd from storage. Extracted to reduce generator complexity. */
const resolveSessionCwd = (
  sessionId: SessionId,
  storageOpt: Option.Option<StorageService>,
): Effect.Effect<string | undefined> =>
  storageOpt._tag === "Some"
    ? storageOpt.value.getSession(sessionId).pipe(
        Effect.map((s) => s?.cwd),
        Effect.orElseSucceed(() => undefined),
      )
    : Effect.void.pipe(Effect.as(undefined as string | undefined))

export interface ToolRunnerService {
  readonly run: (
    toolCall: { toolCallId: ToolCallId; toolName: string; input: unknown },
    ctx: ToolContext,
    /** Per-session profile override. When provided, tool lookup, hooks, host context,
     *  and extension state runtime use this instead of the server-wide services. */
    profileOverride?: {
      readonly registry: ExtensionRegistryService
      readonly stateRuntime?: ExtensionStateRuntimeService
    },
  ) => Effect.Effect<ToolResultPart, InteractionPendingError>
}

const errorResult = (toolCall: { toolCallId: ToolCallId; toolName: string }, message: string) =>
  new ToolResultPart({
    type: "tool-result",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    output: {
      type: "error-json",
      value: { error: message },
    },
  })

export class ToolRunner extends Context.Service<ToolRunner, ToolRunnerService>()(
  "@gent/core/src/runtime/agent/tool-runner/ToolRunner",
) {
  static Live: Layer.Layer<
    ToolRunner,
    never,
    ExtensionRegistry | Permission | ApprovalService | RuntimePlatform | ExtensionStateRuntime
  > = Layer.effect(
    ToolRunner,
    Effect.gen(function* () {
      const extensionRegistry = yield* ExtensionRegistry
      const permission = yield* Permission
      const approvalService = yield* ApprovalService
      const platform = yield* RuntimePlatform
      const extensionStateRuntime = yield* ExtensionStateRuntime

      return ToolRunner.of({
        run: Effect.fn("ToolRunner.run")(function* (toolCall, ctx, profileOverride) {
          return yield* Effect.gen(function* () {
            yield* WideEvent.set({ sessionId: ctx.sessionId, branchId: ctx.branchId })

            // Use per-session profile when provided, falling back to server-wide
            const activeRegistry = profileOverride?.registry ?? extensionRegistry
            const activeStateRuntime = profileOverride?.stateRuntime ?? extensionStateRuntime
            const activeHooks = activeRegistry.hooks

            const tool: AnyToolDefinition | undefined = yield* activeRegistry.getTool(
              toolCall.toolName,
            )
            if (tool === undefined) {
              yield* WideEvent.set({ toolError: ToolError.Unknown })
              yield* Effect.logInfo("tool.unknown").pipe(
                Effect.annotateLogs({
                  toolName: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                }),
              )
              return errorResult(toolCall, `Unknown tool: ${toolCall.toolName}`)
            }

            // Run permission.check interceptor, falling back to base Permission service
            const permCheckResult = yield* activeHooks
              .runInterceptor(
                "permission.check",
                { toolName: toolCall.toolName, input: toolCall.input },
                (input) => permission.check(input.toolName, input.input),
                ctx,
              )
              .pipe(
                Effect.catchEager((e) =>
                  WideEvent.set({
                    toolError: ToolError.PermissionCheckFailed,
                    errorMessage: String(e),
                  }).pipe(Effect.as("interceptor_failed" as const)),
                ),
              )

            if (permCheckResult === "interceptor_failed") {
              yield* Effect.logWarning("tool.permission.check.failed").pipe(
                Effect.annotateLogs({
                  toolName: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                }),
              )
              return errorResult(toolCall, "Permission check failed")
            }

            if (permCheckResult === "denied") {
              yield* WideEvent.set({ toolError: ToolError.PermissionDenied })
              yield* Effect.logInfo("tool.permission.denied").pipe(
                Effect.annotateLogs({
                  toolName: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                }),
              )
              return errorResult(toolCall, "Permission denied")
            }

            const toolDefinition = tool as ToolDefinition<
              string,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              Schema.Decoder<any, never>,
              unknown,
              unknown,
              never
            >
            const decodedInput = yield* Schema.decodeUnknownEffect(toolDefinition.params)(
              toolCall.input,
            ).pipe(Effect.result)
            if (decodedInput._tag === "Failure") {
              const failure = decodedInput.failure
              const message = Schema.isSchemaError(failure)
                ? formatSchemaError(toolCall.toolName, failure)
                : `Invalid tool input: ${String(failure)}`
              yield* WideEvent.set({ toolError: ToolError.SchemaDecode, errorMessage: message })
              yield* Effect.logWarning("tool.schema.failed").pipe(
                Effect.annotateLogs({
                  toolName: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                }),
              )
              return errorResult(toolCall, message)
            }

            // Resolve services lazily to avoid circular Layer deps
            // (AgentRunnerService depends on AgentLoop which depends on ToolRunner)
            const lazyDeps = yield* Effect.all({
              agentRunner: Effect.serviceOption(AgentRunnerService),
              promptPresenter: Effect.serviceOption(PromptPresenter),
              turnControl: Effect.serviceOption(ExtensionTurnControl),
              storage: Effect.serviceOption(Storage),
              searchStorage: Effect.serviceOption(SearchStorage),
              eventPublisherSvc: Effect.serviceOption(EventPublisher),
            })

            const die = (label: string) => () => Effect.die(`${label} not available in ToolRunner`)
            const hostDeps: MakeExtensionHostContextDeps = {
              platform,
              extensionStateRuntime: activeStateRuntime,
              approvalService,
              promptPresenter:
                lazyDeps.promptPresenter._tag === "Some"
                  ? lazyDeps.promptPresenter.value
                  : ({
                      present: die("PromptPresenter"),
                      confirm: die("PromptPresenter"),
                      review: die("PromptPresenter"),
                    } as MakeExtensionHostContextDeps["promptPresenter"]),
              extensionRegistry: activeRegistry,
              turnControl:
                lazyDeps.turnControl._tag === "Some"
                  ? lazyDeps.turnControl.value
                  : ({
                      queueFollowUp: die("TurnControl"),
                      interject: die("TurnControl"),
                      bind: die("TurnControl"),
                    } as MakeExtensionHostContextDeps["turnControl"]),
              storage:
                lazyDeps.storage._tag === "Some"
                  ? lazyDeps.storage.value
                  : ({} as MakeExtensionHostContextDeps["storage"]),
              searchStorage:
                lazyDeps.searchStorage._tag === "Some"
                  ? lazyDeps.searchStorage.value
                  : ({
                      searchMessages: () => Effect.succeed([]),
                    } as MakeExtensionHostContextDeps["searchStorage"]),
              agentRunner:
                lazyDeps.agentRunner._tag === "Some"
                  ? lazyDeps.agentRunner.value
                  : ({
                      run: die("AgentRunnerService"),
                    } as MakeExtensionHostContextDeps["agentRunner"]),
              eventPublisher:
                lazyDeps.eventPublisherSvc._tag === "Some"
                  ? lazyDeps.eventPublisherSvc.value
                  : ({
                      publish: () => Effect.void,
                      terminateSession: die("EventPublisher"),
                    } as MakeExtensionHostContextDeps["eventPublisher"]),
            }

            const sessionCwd = yield* resolveSessionCwd(ctx.sessionId, lazyDeps.storage)

            const hostCtx = makeExtensionHostContext(
              {
                sessionId: ctx.sessionId,
                branchId: ctx.branchId,
                agentName: ctx.agentName,
                sessionCwd,
              },
              hostDeps,
            )
            const richCtx: ToolContext = { ...hostCtx, toolCallId: ctx.toolCallId }

            // Run tool.execute interceptor, falling back to direct tool execution
            const executeResult = yield* activeHooks
              .runInterceptor(
                "tool.execute",
                {
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  input: decodedInput.success,
                  sessionId: ctx.sessionId,
                  branchId: ctx.branchId,
                },
                () =>
                  toolDefinition.execute(decodedInput.success, richCtx) as Effect.Effect<unknown>,
                richCtx,
              )
              .pipe(Effect.result)

            if (executeResult._tag === "Failure") {
              // InteractionPendingError must escape the tool runner so the machine
              // transitions to WaitingForInteraction. The interceptor type system erases
              // the error to `never`, but the error exists at runtime.
              const failure = executeResult.failure as unknown
              if (failure instanceof InteractionPendingError) {
                return yield* Effect.fail(failure)
              }

              const message = Schema.isSchemaError(failure)
                ? formatSchemaError(toolCall.toolName, failure)
                : `Tool '${toolCall.toolName}' failed: ${String(failure)}`
              yield* WideEvent.set({
                toolError: ToolError.ExecutionFailed,
                errorMessage: message,
              })
              yield* Effect.logWarning("tool.execute.failed").pipe(
                Effect.annotateLogs({
                  toolName: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                }),
              )
              return errorResult(toolCall, message)
            }

            // Run tool.result interceptor — extensions can enrich/append to tool results
            const enrichedResult = yield* activeHooks
              .runInterceptor(
                "tool.result",
                {
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  input: decodedInput.success,
                  result: executeResult.success,
                  agentName: ctx.agentName,
                  sessionId: ctx.sessionId,
                  branchId: ctx.branchId,
                },
                (input) => Effect.succeed(input.result),
                richCtx,
              )
              .pipe(
                Effect.catchEager((e) =>
                  WideEvent.set({
                    toolWarning: ToolWarning.ResultEnrichmentFailed,
                    errorMessage: String(e),
                  }).pipe(Effect.as(executeResult.success)),
                ),
              )

            return new ToolResultPart({
              type: "tool-result",
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName,
              output: { type: "json", value: enrichedResult },
            })
          }).pipe(withWideEvent(toolBoundary(toolCall.toolName, toolCall.toolCallId)))
        }),
      })
    }),
  )

  static Test = (): Layer.Layer<ToolRunner> =>
    Layer.succeed(ToolRunner, {
      run: (toolCall) =>
        Effect.succeed(
          new ToolResultPart({
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: { type: "json", value: null },
          }),
        ),
    })
}
