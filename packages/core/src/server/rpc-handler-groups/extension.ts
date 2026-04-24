import { Effect } from "effect"
import { BranchId, SessionId } from "../../domain/ids.js"
import { ExtensionProtocolError } from "../../domain/extension-protocol.js"
import type { Session } from "../../domain/message.js"
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
  readonly phase?: "command" | "request"
  readonly message: string
}) =>
  new ExtensionProtocolError({
    extensionId: params.extensionId,
    tag: params.capabilityId,
    phase: params.phase ?? "request",
    message: params.message,
  })

const resolveExtensionSession = (
  deps: RpcHandlerDeps,
  params: {
    readonly extensionId: string
    readonly tag: string
    readonly phase: "command" | "request"
    readonly sessionId: string
    readonly branchId?: string
  },
): Effect.Effect<
  { readonly sessionId: SessionId; readonly branchId?: BranchId; readonly session: Session },
  ExtensionProtocolError
> =>
  Effect.gen(function* () {
    if (deps.storage === undefined) {
      return yield* extensionRequestError({
        extensionId: params.extensionId,
        capabilityId: params.tag,
        phase: params.phase,
        message: "Session storage unavailable for extension transport",
      })
    }

    const requestSessionId = SessionId.make(params.sessionId)
    const requestBranchId =
      params.branchId === undefined ? undefined : BranchId.make(params.branchId)
    const session = yield* deps.storage.getSession(requestSessionId).pipe(
      Effect.mapError((error) =>
        extensionRequestError({
          extensionId: params.extensionId,
          capabilityId: params.tag,
          phase: params.phase,
          message: `Session lookup failed: ${error.message}`,
        }),
      ),
    )
    if (session === undefined) {
      return yield* extensionRequestError({
        extensionId: params.extensionId,
        capabilityId: params.tag,
        phase: params.phase,
        message: "Session not found for extension transport",
      })
    }

    if (requestBranchId !== undefined) {
      const branch = yield* deps.storage.getBranch(requestBranchId).pipe(
        Effect.mapError((error) =>
          extensionRequestError({
            extensionId: params.extensionId,
            capabilityId: params.tag,
            phase: params.phase,
            message: `Branch lookup failed: ${error.message}`,
          }),
        ),
      )
      if (branch === undefined || branch.sessionId !== requestSessionId) {
        return yield* extensionRequestError({
          extensionId: params.extensionId,
          capabilityId: params.tag,
          phase: params.phase,
          message: "Branch does not belong to extension transport session",
        })
      }
    }

    return { sessionId: requestSessionId, branchId: requestBranchId, session }
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
      const scope = yield* resolveExtensionSession(deps, {
        extensionId: message.extensionId,
        tag: message._tag,
        phase: "command",
        sessionId,
        branchId,
      })
      yield* Effect.logDebug("rpc.extension.send.received").pipe(
        Effect.annotateLogs({
          sessionId,
          extensionId: message.extensionId,
          tag: message._tag,
          branchId,
        }),
      )
      const { stateRuntime } = yield* deps.resolveSessionServices(sessionId)
      yield* stateRuntime.send(scope.sessionId, message, scope.branchId)
      if (deps.bus !== undefined) {
        yield* deps.bus
          .emit({
            channel: `${message.extensionId}:${message._tag}`,
            payload: message,
            sessionId: scope.sessionId,
            branchId: scope.branchId,
          })
          .pipe(Effect.catchEager(() => Effect.void))
      }
    }),

  "extension.ask": ({ sessionId, message, branchId }: AskExtensionMessageInput) =>
    Effect.gen(function* () {
      const scope = yield* resolveExtensionSession(deps, {
        extensionId: message.extensionId,
        tag: message._tag,
        phase: "request",
        sessionId,
        branchId,
      })
      yield* Effect.logDebug("rpc.extension.ask.received").pipe(
        Effect.annotateLogs({
          sessionId,
          extensionId: message.extensionId,
          tag: message._tag,
          branchId,
        }),
      )
      const { stateRuntime } = yield* deps.resolveSessionServices(sessionId)
      const reply = yield* stateRuntime.execute(scope.sessionId, message, scope.branchId)
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
      const scope = yield* resolveExtensionSession(deps, {
        extensionId,
        tag: capabilityId,
        phase: "request",
        sessionId,
        branchId,
      })
      if (scope.session.cwd === undefined) {
        return yield* extensionRequestError({
          extensionId,
          capabilityId,
          message: "Session cwd unavailable for extension request",
        })
      }
      if (scope.branchId === undefined) {
        return yield* extensionRequestError({
          extensionId,
          capabilityId,
          message: "Branch unavailable for extension request",
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
            sessionId: scope.sessionId,
            branchId: scope.branchId,
            cwd: scope.session.cwd,
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
