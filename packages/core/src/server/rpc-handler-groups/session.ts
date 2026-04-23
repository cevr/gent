import { Effect, Stream } from "effect"
import { EventId } from "../../domain/event.js"
import type { SessionTreeNode as DomainSessionTreeNode } from "../../domain/message.js"
import { WideEvent, rpcBoundary, withWideEvent } from "../../runtime/wide-event-boundary.js"
import type {
  CreateBranchInput,
  CreateSessionInput,
  ForkBranchInput,
  GetBranchTreeInput,
  GetChildSessionsInput,
  GetSessionSnapshotInput,
  GetSessionTreeInput,
  ListBranchesInput,
  ListMessagesInput,
  QueueTarget,
  RespondInteractionInput,
  SendMessageInput,
  SteerCommand as TransportSteerCommand,
  SubscribeEventsInput,
  SwitchBranchInput,
  SessionTreeNode as RpcSessionTreeNode,
  UpdateSessionReasoningLevelInput,
  WatchRuntimeInput,
} from "../transport-contract.js"
import type { RpcHandlerDeps } from "./shared.js"
import { isPublicTransportEvent, watchRuntimeStream } from "./shared.js"

const toRpcSessionTree = (node: DomainSessionTreeNode): RpcSessionTreeNode => ({
  id: node.session.id,
  name: node.session.name,
  cwd: node.session.cwd,
  parentSessionId: node.session.parentSessionId,
  parentBranchId: node.session.parentBranchId,
  createdAt: node.session.createdAt.getTime(),
  updatedAt: node.session.updatedAt.getTime(),
  children: node.children.map(toRpcSessionTree),
})

export const buildSessionRpcHandlers = (deps: RpcHandlerDeps) => ({
  "session.create": (input: CreateSessionInput) =>
    deps.commands
      .createSession({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
        ...(input.parentBranchId !== undefined ? { parentBranchId: input.parentBranchId } : {}),
        ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}),
        ...(input.agentOverride !== undefined ? { agentOverride: input.agentOverride } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      })
      .pipe(
        Effect.tap((result) => WideEvent.set({ sessionId: result.sessionId })),
        withWideEvent(rpcBoundary("session.create", input.requestId)),
      ),

  "session.list": () => deps.queries.listSessions(),

  "session.get": ({ sessionId }: GetSessionTreeInput) => deps.queries.getSession(sessionId),

  "session.delete": ({ sessionId }: GetSessionTreeInput) =>
    deps.commands.deleteSession(sessionId).pipe(
      Effect.tap(() => WideEvent.set({ sessionId })),
      withWideEvent(rpcBoundary("session.delete")),
    ),

  "session.getChildren": ({ parentSessionId }: GetChildSessionsInput) =>
    deps.queries.getChildSessions(parentSessionId),

  "session.getTree": ({ sessionId }: GetSessionTreeInput) =>
    deps.queries.getSessionTree(sessionId).pipe(Effect.map(toRpcSessionTree)),

  "session.getSnapshot": ({ sessionId, branchId }: GetSessionSnapshotInput) =>
    deps.queries.getSessionSnapshot({ sessionId, branchId }),

  "session.updateReasoningLevel": ({
    sessionId,
    reasoningLevel,
  }: UpdateSessionReasoningLevelInput) =>
    deps.commands.updateSessionReasoningLevel({ sessionId, reasoningLevel }),

  "session.events": ({ sessionId, branchId, after }: SubscribeEventsInput) =>
    deps.eventStore
      .subscribe({
        sessionId,
        ...(branchId !== undefined ? { branchId } : {}),
        ...(after !== undefined ? { after: EventId.make(after) } : {}),
      })
      .pipe(Stream.filter(isPublicTransportEvent)),

  "session.watchRuntime": (input: WatchRuntimeInput) => watchRuntimeStream(deps, input),

  "branch.list": ({ sessionId }: ListBranchesInput) => deps.queries.listBranches(sessionId),

  "branch.create": ({ sessionId, name }: CreateBranchInput) =>
    deps.commands.createBranch({
      sessionId,
      ...(name !== undefined ? { name } : {}),
    }),

  "branch.getTree": ({ sessionId }: GetBranchTreeInput) => deps.queries.getBranchTree(sessionId),

  "branch.switch": ({ sessionId, fromBranchId, toBranchId, summarize }: SwitchBranchInput) =>
    deps.commands.switchBranch({
      sessionId,
      fromBranchId,
      toBranchId,
      ...(summarize !== undefined ? { summarize } : {}),
    }),

  "branch.fork": ({ sessionId, fromBranchId, atMessageId, name }: ForkBranchInput) =>
    deps.commands.forkBranch({
      sessionId,
      fromBranchId,
      atMessageId,
      ...(name !== undefined ? { name } : {}),
    }),

  "message.send": ({
    sessionId,
    branchId,
    content,
    agentOverride,
    runSpec,
    requestId,
  }: SendMessageInput) =>
    deps.commands
      .sendMessage({
        sessionId,
        branchId,
        content,
        ...(agentOverride !== undefined ? { agentOverride } : {}),
        ...(runSpec !== undefined ? { runSpec } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      })
      .pipe(
        Effect.tap(() => WideEvent.set({ sessionId, branchId })),
        withWideEvent(rpcBoundary("message.send", requestId)),
      ),

  "message.list": ({ branchId }: ListMessagesInput) => deps.queries.listMessages(branchId),

  "steer.command": ({ command }: { readonly command: TransportSteerCommand }) =>
    deps.commands.steer(command),

  "queue.drain": ({ sessionId, branchId }: QueueTarget) =>
    deps.commands.drainQueuedMessages({ sessionId, branchId }),

  "queue.get": ({ sessionId, branchId }: QueueTarget) =>
    deps.queries.getQueuedMessages({ sessionId, branchId }),

  "interaction.respondInteraction": ({
    requestId,
    sessionId,
    branchId,
    approved,
    notes,
  }: RespondInteractionInput) =>
    deps.interactions.respond({
      requestId,
      sessionId,
      branchId,
      approved,
      ...(notes !== undefined ? { notes } : {}),
    }),
})
