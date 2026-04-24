import { Effect } from "effect"
import { BranchId, SessionId } from "../../domain/ids.js"
import { ExtensionProtocolError } from "../../domain/extension-protocol.js"
import { listSlashCommands } from "../../runtime/extensions/registry.js"
import { buildExtensionHealthSnapshot } from "../extension-health.js"
import { CommandInfo } from "../transport-contract.js"
import type {
  AskExtensionMessageInput,
  ListExtensionCommandsInput,
  ListExtensionStatusInput,
  RequestCapabilityInput,
  SendExtensionMessageInput,
} from "../transport-contract.js"
import type { RpcHandlerDeps } from "./shared.js"

const extensionRequestError = (params: {
  readonly extensionId: string
  readonly capabilityId: string
  readonly message: string
}) =>
  new ExtensionProtocolError({
    extensionId: params.extensionId,
    tag: params.capabilityId,
    phase: "request",
    message: params.message,
  })

export const buildExtensionRpcHandlers = (deps: RpcHandlerDeps) => ({
  "extension.listStatus": ({ sessionId }: ListExtensionStatusInput) =>
    Effect.gen(function* () {
      const { registry, stateRuntime } = yield* deps.resolveSessionServices(sessionId)
      const activationStatuses = yield* registry.listExtensionStatuses()
      const actorStatuses =
        sessionId === undefined ? [] : yield* stateRuntime.getActorStatuses(sessionId)
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
      const { stateRuntime } = yield* deps.resolveSessionServices(sessionId)
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
      const { stateRuntime } = yield* deps.resolveSessionServices(sessionId)
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
      if (deps.storage === undefined) {
        return yield* extensionRequestError({
          extensionId,
          capabilityId,
          message: "Session storage unavailable for extension request",
        })
      }

      const requestSessionId = SessionId.make(sessionId)
      const requestBranchId = BranchId.make(branchId)
      const session = yield* deps.storage.getSession(requestSessionId).pipe(
        Effect.mapError((error) =>
          extensionRequestError({
            extensionId,
            capabilityId,
            message: `Session lookup failed: ${error.message}`,
          }),
        ),
      )
      if (session === undefined) {
        return yield* extensionRequestError({
          extensionId,
          capabilityId,
          message: "Session not found for extension request",
        })
      }
      if (session.cwd === undefined) {
        return yield* extensionRequestError({
          extensionId,
          capabilityId,
          message: "Session cwd unavailable for extension request",
        })
      }

      const branch = yield* deps.storage.getBranch(requestBranchId).pipe(
        Effect.mapError((error) =>
          extensionRequestError({
            extensionId,
            capabilityId,
            message: `Branch lookup failed: ${error.message}`,
          }),
        ),
      )
      if (branch === undefined || branch.sessionId !== requestSessionId) {
        return yield* extensionRequestError({
          extensionId,
          capabilityId,
          message: "Branch does not belong to extension request session",
        })
      }

      const { registry, capabilityContext } = yield* deps.resolveSessionServices(sessionId)
      const capabilities = registry.getResolved().capabilities
      const request = capabilities
        .run(
          extensionId,
          capabilityId,
          "transport-public",
          input,
          {
            sessionId: requestSessionId,
            branchId: requestBranchId,
            cwd: session.cwd,
            home: deps.platform.home,
          },
          { intent },
        )
        .pipe(
          Effect.mapError((error) =>
            extensionRequestError({
              extensionId,
              capabilityId,
              message: "reason" in error ? `${error._tag}: ${error.reason}` : error._tag,
            }),
          ),
        )
      return yield* capabilityContext !== undefined
        ? request.pipe(Effect.provideContext(capabilityContext))
        : request
    }),

  "extension.listCommands": ({ sessionId }: ListExtensionCommandsInput) =>
    Effect.gen(function* () {
      const { registry } = yield* deps.resolveSessionServices(sessionId)
      return listSlashCommands(registry.getResolved().extensions, { publicOnly: true }).map(
        (command) =>
          new CommandInfo({
            name: command.name,
            description: command.description,
            extensionId: command.extensionId,
            capabilityId: command.capabilityId,
            intent: command.intent,
          }),
      )
    }),
})
