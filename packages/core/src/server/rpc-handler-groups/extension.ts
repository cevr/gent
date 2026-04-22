import { Effect } from "effect"
import { BranchId, SessionId } from "../../domain/ids.js"
import { ExtensionProtocolError } from "../../domain/extension-protocol.js"
import { listSlashCommands } from "../../runtime/extensions/registry.js"
import { buildExtensionHealthSnapshot } from "../extension-health.js"
import type {
  AskExtensionMessageInput,
  ListExtensionCommandsInput,
  ListExtensionStatusInput,
  RequestCapabilityInput,
  SendExtensionMessageInput,
} from "../transport-contract.js"
import type { RpcHandlerDeps } from "./shared.js"

export const buildExtensionRpcHandlers = (deps: RpcHandlerDeps) => ({
  "extension.listStatus": ({ sessionId }: ListExtensionStatusInput) =>
    Effect.gen(function* () {
      const profile =
        sessionId !== undefined ? yield* deps.resolveSessionProfile(sessionId) : undefined
      const activeRegistry = profile?.registry ?? deps.extensionRegistry
      const activeRuntime = profile?.stateRuntime ?? deps.extensionStateRuntime
      const activationStatuses = yield* activeRegistry.listExtensionStatuses()
      const actorStatuses =
        sessionId === undefined ? [] : yield* activeRuntime.getActorStatuses(sessionId)
      return buildExtensionHealthSnapshot(activationStatuses, actorStatuses)
    }),

  "extension.send": ({ sessionId, message, branchId }: SendExtensionMessageInput) =>
    Effect.gen(function* () {
      yield* Effect.logDebug("rpc.extension.send.received").pipe(
        Effect.annotateLogs({
          sessionId,
          extensionId: message.extensionId,
          tag: message._tag,
          branchId,
        }),
      )
      const { stateRuntime } = yield* deps.resolveSessionProfile(sessionId)
      yield* stateRuntime.send(sessionId, message, branchId)
      if (deps.bus !== undefined) {
        yield* deps.bus
          .emit({
            channel: `${message.extensionId}:${message._tag}`,
            payload: message,
            sessionId,
            branchId,
          })
          .pipe(Effect.catchEager(() => Effect.void))
      }
    }),

  "extension.ask": ({ sessionId, message, branchId }: AskExtensionMessageInput) =>
    Effect.gen(function* () {
      yield* Effect.logDebug("rpc.extension.ask.received").pipe(
        Effect.annotateLogs({
          sessionId,
          extensionId: message.extensionId,
          tag: message._tag,
          branchId,
        }),
      )
      const { stateRuntime } = yield* deps.resolveSessionProfile(sessionId)
      const reply = yield* stateRuntime.execute(sessionId, message, branchId)
      yield* Effect.logDebug("rpc.extension.ask.replied").pipe(
        Effect.annotateLogs({
          sessionId,
          extensionId: message.extensionId,
          tag: message._tag,
        }),
      )
      return reply
    }),

  "extension.request": ({
    sessionId,
    extensionId,
    capabilityId,
    intent,
    input,
    branchId,
  }: RequestCapabilityInput) =>
    Effect.gen(function* () {
      const { registry } = yield* deps.resolveSessionProfile(sessionId)
      const capabilities = registry.getResolved().capabilities
      return yield* capabilities
        .run(
          extensionId,
          capabilityId,
          "transport-public",
          input,
          {
            sessionId: SessionId.of(sessionId),
            branchId: BranchId.of(branchId),
            cwd: deps.platform.cwd,
            home: deps.platform.home,
          },
          { intent },
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new ExtensionProtocolError({
                extensionId,
                tag: capabilityId,
                phase: "request",
                message: "reason" in error ? `${error._tag}: ${error.reason}` : error._tag,
              }),
          ),
        )
    }),

  "extension.listCommands": ({ sessionId }: ListExtensionCommandsInput) =>
    Effect.gen(function* () {
      const { registry } = yield* deps.resolveSessionProfile(sessionId)
      return listSlashCommands(registry.getResolved().extensions, { publicOnly: true }).map(
        (command) => ({
          name: command.name,
          description: command.description,
          extensionId: command.extensionId,
          capabilityId: command.capabilityId,
          intent: command.intent,
        }),
      )
    }),
})
