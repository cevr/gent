/**
 * The host context an extension reaches through `ExtensionContext`.
 *
 * Built once per loop from the services in scope. A facet whose service is
 * absent still assembles; it reports the absence only if something calls it,
 * so a root that ships no approval flow provides no stub for one.
 */

import { Context, DateTime, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as Prompt from "effect/unstable/ai/Prompt"
import { ActorStateRegistry, listStateEntityIds } from "effect-encore"
import {
  ExtensionHostSearchResult,
  extensionServiceError,
  type ExtensionHostContext,
  type ExtensionServiceError,
} from "../domain/extension-services.js"
import { InteractionPendingError } from "../domain/interaction-request.js"
import { AgentRunnerService, type AgentName } from "../domain/agent.js"
import { BranchId, MessageId, SessionId } from "../domain/ids.js"
import { RuntimeEnvironment, type RuntimeEnvironmentApi } from "./runtime-environment.js"
import type { ExtensionHostPlatform } from "../domain/extension.js"
import { ApprovalService } from "./approval-service.js"
import type { ExtensionRegistryService } from "./extensions/registry.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { Message, type MessageMetadata } from "../domain/message.js"
import { EventPublisher } from "../domain/event-publisher.js"
import { MessageReceived } from "../domain/event.js"
import { SessionMutations } from "../domain/session-mutations.js"
import { AgentLoop as AgentLoopActor } from "./agent/agent-loop.protocol.js"
import { listWorkspaceLoops } from "./agent/agent-loop.entity-id.js"
import { CurrentWorkspaceId } from "../server/workspace-rpc.js"

interface ExtensionSessionControlService {
  readonly queueFollowUp: (input: {
    readonly sourceId: string
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly content: string
    readonly metadata?: MessageMetadata
    readonly wake?: boolean
  }) => Effect.Effect<void, Error>
  readonly dequeueFollowUp: (input: {
    readonly sourceId: string
    readonly sessionId: SessionId
    readonly branchId: BranchId
  }) => Effect.Effect<boolean, Error>
}

/** Decoding entity ids is cheap; bound it so a large registry does not stall a listing. */
const ACTIVE_LOOP_DECODE_CONCURRENCY = 8

interface ExtensionHostContextInput {
  readonly extensionRegistry: ExtensionRegistryService
  /** Built by the caller over `GentPlatform`, which is an Effect rather than a service Tag. */
  readonly host: ExtensionHostPlatform
  /** The loop's follow-up queue. Absent outside a loop. */
  readonly sessionControl?: ExtensionSessionControlService
}

interface MakeExtensionHostContextRunInfo {
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly agentName?: AgentName
  /** Session-scoped cwd. Falls back to RuntimeEnvironment.cwd when absent. */
  readonly sessionCwd?: string
}

interface ExtensionHostContextProviderService {
  readonly defaultExtensionRegistry: ExtensionRegistryService
  readonly forRun: (
    runInfo: MakeExtensionHostContextRunInfo,
    extensionRegistry?: ExtensionRegistryService,
  ) => ExtensionHostContext
}

export class ExtensionHostContextProvider extends Context.Service<
  ExtensionHostContextProvider,
  ExtensionHostContextProviderService
>()("@gent/core/src/runtime/make-extension-host-context/ExtensionHostContextProvider") {}

/** Runs `use` against the service, or dies naming the absent one. */
type Facet<S> = <A, E, R>(use: (service: S) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

const via =
  <S>(service: Option.Option<S>, name: string): Facet<S> =>
  (use) =>
    Option.match(service, {
      onNone: () => Effect.die(`${name} not available`),
      onSome: use,
    })

const facet = <I, S>(tag: Context.Key<I, S>, name: string): Effect.Effect<Facet<S>> =>
  Effect.serviceOption(tag).pipe(Effect.map((service) => via(service, name)))

const sessionError = (operation: string) => extensionServiceError("ExtensionSession", operation)

/** A pending interaction is the caller's to handle; anything else is a service failure. */
const mapInteraction = <A, E>(
  operation: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, ExtensionServiceError | InteractionPendingError> =>
  effect.pipe(
    Effect.mapError((cause) => {
      if (Schema.is(InteractionPendingError)(cause)) return cause
      return extensionServiceError("ExtensionInteraction", operation)(cause)
    }),
  )

const unavailablePlatform: RuntimeEnvironmentApi = { cwd: "", home: "", platform: "unknown" }

export const makeExtensionHostContextProvider = (
  input: ExtensionHostContextInput,
): Effect.Effect<ExtensionHostContextProviderService> =>
  Effect.gen(function* () {
    const platform = Option.getOrElse(
      yield* Effect.serviceOption(RuntimeEnvironment),
      () => unavailablePlatform,
    )
    const host = input.host
    const control = via(Option.fromUndefinedOr(input.sessionControl), "SessionControl")
    const approval = yield* facet(ApprovalService, "ApprovalService")
    const publisher = yield* facet(EventPublisher, "EventPublisher")
    const sql = yield* facet(SqlClient.SqlClient, "SqlClient")
    const sessions = yield* facet(SessionStorage, "SessionStorage")
    const branches = yield* facet(BranchStorage, "BranchStorage")
    const messages = yield* facet(MessageStorage, "MessageStorage")
    const relationships = yield* facet(RelationshipStorage, "RelationshipStorage")
    const agents = yield* facet(AgentRunnerService, "AgentRunnerService")
    const mutations = yield* facet(SessionMutations, "SessionMutations")
    // Enumerating a workspace's loops needs only the actor state registry,
    // which exists only where an actor layer is in scope.
    const registry = yield* facet(ActorStateRegistry, "ActorStateRegistry")

    const forRun = (
      runInfo: MakeExtensionHostContextRunInfo,
      extensionRegistry: ExtensionRegistryService = input.extensionRegistry,
    ): ExtensionHostContext => ({
      sessionId: runInfo.sessionId,
      branchId: runInfo.branchId,
      agentName: runInfo.agentName,
      cwd: runInfo.sessionCwd ?? platform.cwd,
      home: platform.home,
      host,

      Agent: {
        listAgents: Effect.succeed([...extensionRegistry.getResolved().agents.values()]),
        start: (params) =>
          agents((runner) =>
            runner.start({
              ...params,
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
              cwd: params.cwd ?? runInfo.sessionCwd ?? platform.cwd,
            }),
          ),
        inspect: (params) =>
          agents((runner) =>
            runner.inspect({
              requestId: params.requestId,
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
            }),
          ),
        list: () =>
          agents((runner) =>
            runner.list({
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
            }),
          ),
        cancel: (params) =>
          agents((runner) =>
            runner.cancel({
              requestId: params.requestId,
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
            }),
          ),
        run: (params) =>
          agents((runner) =>
            runner.run({
              agent: params.agent,
              prompt: params.prompt,
              parentSessionId: runInfo.sessionId,
              parentBranchId: runInfo.branchId,
              cwd: params.cwd ?? runInfo.sessionCwd ?? platform.cwd,
              runSpec: params.runSpec,
              observe: params.observe,
            }),
          ).pipe(Effect.mapError(extensionServiceError("ExtensionAgent", "run"))),
      },

      Session: {
        listMessages: (branchId) =>
          messages((storage) => storage.listMessages(branchId ?? runInfo.branchId)).pipe(
            Effect.mapError(sessionError("listMessages")),
          ),
        getSession: (sessionId) =>
          sessions((storage) => storage.getSession(sessionId ?? runInfo.sessionId)).pipe(
            Effect.mapError(sessionError("getSession")),
          ),
        getDetail: (sessionId) =>
          relationships((storage) => storage.getSessionDetail(sessionId)).pipe(
            Effect.mapError(sessionError("getDetail")),
          ),
        renameCurrent: (name) =>
          mutations((service) =>
            service.renameSession({ sessionId: runInfo.sessionId, name }),
          ).pipe(Effect.mapError(sessionError("renameCurrent"))),
        search: (query, options) =>
          messages((storage) => storage.searchMessages(query, options)).pipe(
            Effect.map((results) =>
              results.map((result) =>
                ExtensionHostSearchResult.make({
                  sessionId: SessionId.make(result.sessionId),
                  sessionName: result.sessionName,
                  branchId: BranchId.make(result.branchId),
                  snippet: result.snippet,
                  createdAt: result.createdAt,
                }),
              ),
            ),
            Effect.mapError(sessionError("search")),
          ),
        queueFollowUp: (params) =>
          control((loop) =>
            loop.queueFollowUp({
              sourceId: params.sourceId,
              sessionId: runInfo.sessionId,
              branchId: params.branchId ?? runInfo.branchId,
              content: params.content,
              metadata: params.metadata,
              wake: params.wake,
            }),
          ).pipe(Effect.mapError(sessionError("queueFollowUp"))),
        dequeueFollowUp: (params) =>
          control((loop) =>
            loop.dequeueFollowUp({
              sourceId: params.sourceId,
              sessionId: runInfo.sessionId,
              branchId: params.branchId ?? runInfo.branchId,
            }),
          ).pipe(Effect.mapError(sessionError("dequeueFollowUp"))),
        listBranches: branches((storage) => storage.listBranches(runInfo.sessionId)).pipe(
          Effect.mapError(sessionError("listBranches")),
        ),
        listSessions: sessions((storage) => storage.listSessions).pipe(
          Effect.mapError(sessionError("listSessions")),
        ),
        listActiveLoops: registry((stateRegistry) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const entityIds = yield* listStateEntityIds(AgentLoopActor.name).pipe(
              Effect.provideService(ActorStateRegistry, stateRegistry),
            )
            return yield* listWorkspaceLoops({
              workspaceId,
              entityIds,
              concurrency: ACTIVE_LOOP_DECODE_CONCURRENCY,
            })
          }),
        ).pipe(Effect.mapError(sessionError("listActiveLoops"))),
      },

      Interaction: {
        approve: (params) =>
          mapInteraction(
            "approve",
            approval((service) =>
              service.present(params, { sessionId: runInfo.sessionId, branchId: runInfo.branchId }),
            ),
          ),
        // A presented note is a hidden assistant message: stored, then delivered.
        present: (params) =>
          mapInteraction(
            "present",
            Effect.gen(function* () {
              const text = Option.match(Option.fromUndefinedOr(params.title), {
                onNone: () => params.content,
                onSome: (title) => `# ${title}\n\n${params.content}`,
              })
              const message = Message.cases.regular.make({
                id: MessageId.make(yield* host.randomId),
                sessionId: runInfo.sessionId,
                branchId: runInfo.branchId,
                role: "assistant",
                parts: [Prompt.textPart({ text })],
                createdAt: yield* DateTime.nowAsDate,
                metadata: { customType: "prompt-present", hidden: true },
              })
              const envelope = yield* sql((client) =>
                messages((store) => store.createMessage(message)).pipe(
                  Effect.andThen(
                    publisher((events) => events.append(MessageReceived.make({ message }))),
                  ),
                  client.withTransaction,
                ),
              )
              yield* publisher((events) => events.deliver(envelope))
            }),
          ),
      },
    })

    return { defaultExtensionRegistry: input.extensionRegistry, forRun }
  })
