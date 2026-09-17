/**
 * The host context an extension reaches through `ExtensionContext`.
 *
 * Built once per loop from the services in scope. A facet whose service is
 * absent still assembles; it reports the absence only if something calls it,
 * so a root that ships no approval flow provides no stub for one.
 */

import { Context, DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import * as Prompt from "effect/unstable/ai/Prompt"
import { ActorStateRegistry, listStateEntityIds, stateOf } from "effect-encore"
import {
  extensionServiceError,
  mapExtensionServiceError,
  ExtensionServiceError as ExtensionServiceErrorClass,
  type ExtensionFilesService,
  type ExtensionFileLockServiceApi,
  type ExtensionHostContext,
  type ExtensionProcessService,
  type ExtensionServiceError,
  type ExtensionStateFacet,
} from "../domain/extension-services.js"
import { makeFileWriter } from "../domain/file-writer.js"
import { FileLockService } from "../domain/file-lock.js"
import { InteractionPendingError } from "../domain/interaction-request.js"
import { AgentRunnerService } from "../domain/agent.js"
import { MessageId, type BranchId, type SessionId } from "../domain/ids.js"
import { RuntimeEnvironment, type RuntimeEnvironmentApi } from "./runtime-environment.js"
import type { ExtensionHostPlatform } from "../domain/extension.js"
import { ApprovalService } from "./approval-service.js"
import type { ExtensionRegistryService } from "./extensions/registry.js"
import { BranchStorage } from "../storage/branch-storage.js"
import { MessageStorage } from "../storage/message-storage.js"
import { RelationshipStorage } from "../storage/relationship-storage.js"
import { SessionStorage } from "../storage/session-storage.js"
import { Message, type MessageMetadata } from "../domain/message.js"
import { EventPublisher, ExtensionStatePublisher } from "../domain/event-publisher.js"
import { MessageReceived } from "../domain/event.js"
import { SessionMutations } from "../domain/session-mutations.js"
import { AgentLoop as AgentLoopActor } from "./agent/agent-loop.protocol.js"
import { entityIdOf, listWorkspaceLoops } from "./agent/agent-loop.entity-id.js"
import type { SessionRuntimeState } from "./agent/agent-loop.state.js"
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

    // A session call made later from a background fiber, after the turn that
    // built this context, must still land in the workspace the loop opened
    // under. The actor decodes that workspace from its entity id and provides
    // it around this construction, so pinning it here anchors every later call
    // to the loop rather than to whichever fiber happens to make it.
    const workspaceId = yield* CurrentWorkspaceId
    const inWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      effect.pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))

    const Process: ExtensionProcessService = {
      randomId: host.randomId,
      run: (command, args, options) =>
        mapExtensionServiceError(
          "ExtensionProcess",
          "run",
          host.runProcess(command, args, options),
        ),
      parentEnv: host.parentEnv,
    }

    // The file facets read their platform services optionally, so a root that
    // ships no file system still assembles a context; the facet reports the
    // absence only when something calls it.
    const fs = yield* facet(FileSystem.FileSystem, "FileSystem")
    const pathOption = yield* Effect.serviceOption(Path.Path)
    // `resolve`, `join` and `dirname` are synchronous in the facet, so an
    // absent path service can only be reported as a defect at call time.
    const onPath = <A>(use: (path: Path.Path) => A): A =>
      Option.match(pathOption, {
        onNone: (): A => {
          // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- The facet's path helpers are synchronous, so an unwired path service can only surface as a defect here.
          throw new Error("Path not available")
        },
        onSome: use,
      })
    const writeFile = (
      fileSystem: FileSystem.FileSystem,
      path: string,
      content: string,
      options?: { readonly atomic?: boolean },
    ) =>
      makeFileWriter(fileSystem, (target) => onPath((p) => p.dirname(target)))(
        path,
        content,
        options,
      )
    const Files: ExtensionFilesService = {
      read: (path) =>
        mapExtensionServiceError(
          "ExtensionFiles",
          "read",
          fs((s) => s.readFileString(path)),
        ),
      write: (path, content, options) =>
        mapExtensionServiceError(
          "ExtensionFiles",
          "write",
          fs((s) => writeFile(s, path, content, options)),
        ),
      exists: (path) =>
        mapExtensionServiceError(
          "ExtensionFiles",
          "exists",
          fs((s) => s.exists(path)),
        ),
      stat: (path) =>
        mapExtensionServiceError(
          "ExtensionFiles",
          "stat",
          fs((s) =>
            s.stat(path).pipe(
              Effect.map((info) => ({
                type: info.type,
                size: info.size,
                mtime: Option.getOrUndefined(info.mtime),
              })),
            ),
          ),
        ),
      makeDirectory: (path, options) =>
        mapExtensionServiceError(
          "ExtensionFiles",
          "makeDirectory",
          fs((s) => s.makeDirectory(path, options)),
        ),
      resolve: (...paths) => onPath((p) => p.resolve(...paths)),
      join: (...paths) => onPath((p) => p.join(...paths)),
      dirname: (path) => onPath((p) => p.dirname(path)),
    }

    const fileLockOption = yield* Effect.serviceOption(FileLockService)
    const FileLock: ExtensionFileLockServiceApi = Option.match(fileLockOption, {
      onNone: () => ({ withLock: (_path, effect) => effect }),
      onSome: (fileLock) => ({ withLock: (path, effect) => fileLock.withLock(path, effect) }),
    })

    const statePublisherOption = yield* Effect.serviceOption(ExtensionStatePublisher)

    const forRun = (
      runInfo: MakeExtensionHostContextRunInfo,
      extensionRegistry: ExtensionRegistryService = input.extensionRegistry,
    ): ExtensionHostContext => ({
      sessionId: runInfo.sessionId,
      branchId: runInfo.branchId,
      cwd: runInfo.sessionCwd ?? platform.cwd,
      home: platform.home,
      host,
      Process,
      Files,
      FileLock,

      State: ((extensionId) =>
        Option.match(statePublisherOption, {
          onNone: () => ({ changed: () => Effect.void }),
          onSome: (statePublisher) =>
            Option.match(extensionId, {
              onNone: () => ({
                changed: () =>
                  Effect.fail(
                    new ExtensionServiceErrorClass({
                      service: "ExtensionState",
                      operation: "changed",
                      message: "Extension id unavailable for state change notification",
                    }),
                  ),
              }),
              onSome: (id) => ({
                changed: () =>
                  mapExtensionServiceError(
                    "ExtensionState",
                    "changed",
                    inWorkspace(
                      statePublisher.changed({
                        extensionId: id,
                        sessionId: runInfo.sessionId,
                        branchId: runInfo.branchId,
                      }),
                    ),
                  ),
              }),
            }),
        })) satisfies ExtensionStateFacet,

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
        send: (params) =>
          agents((runner) =>
            runner.send({
              ...params,
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
        getSession: (sessionId) =>
          sessions((storage) => storage.getSession(sessionId ?? runInfo.sessionId)).pipe(
            Effect.mapError(sessionError("getSession")),
            inWorkspace,
          ),
        getDetail: (sessionId) =>
          relationships((storage) => storage.getSessionDetail(sessionId)).pipe(
            Effect.mapError(sessionError("getDetail")),
            inWorkspace,
          ),
        renameCurrent: (name) =>
          mutations((service) =>
            service.renameSession({ sessionId: runInfo.sessionId, name }),
          ).pipe(Effect.mapError(sessionError("renameCurrent")), inWorkspace),
        search: (query, options) =>
          messages((storage) => storage.searchMessages(query, options)).pipe(
            Effect.mapError(sessionError("search")),
            inWorkspace,
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
          ).pipe(Effect.mapError(sessionError("queueFollowUp")), inWorkspace),
        dequeueFollowUp: (params) =>
          control((loop) =>
            loop.dequeueFollowUp({
              sourceId: params.sourceId,
              sessionId: runInfo.sessionId,
              branchId: params.branchId ?? runInfo.branchId,
            }),
          ).pipe(Effect.mapError(sessionError("dequeueFollowUp")), inWorkspace),
        listBranches: branches((storage) => storage.listBranches(runInfo.sessionId)).pipe(
          Effect.mapError(sessionError("listBranches")),
          inWorkspace,
        ),
        listSessions: sessions((storage) => storage.listSessions).pipe(
          Effect.mapError(sessionError("listSessions")),
          inWorkspace,
        ),
        listActiveLoops: registry((stateRegistry) =>
          Effect.gen(function* () {
            const workspaceId = yield* CurrentWorkspaceId
            const entityIds = yield* listStateEntityIds(AgentLoopActor.name).pipe(
              Effect.provideService(ActorStateRegistry, stateRegistry),
            )
            const loops = yield* listWorkspaceLoops({
              workspaceId,
              entityIds,
              concurrency: ACTIVE_LOOP_DECODE_CONCURRENCY,
            })
            // The loop registers its runtime state with the registry, so the
            // status is a memory read: no actor message, no mutation permit.
            return yield* Effect.forEach(
              loops,
              (loop) =>
                stateOf<SessionRuntimeState>({
                  entityType: AgentLoopActor.name,
                  entityId: entityIdOf(workspaceId, loop.sessionId, loop.branchId),
                }).pipe(
                  Effect.map((state) => Option.some(state._tag)),
                  Effect.catchEager(() => Effect.succeed(Option.none<string>())),
                  Effect.provideService(ActorStateRegistry, stateRegistry),
                  Effect.map((status) => ({ ...loop, status })),
                ),
              { concurrency: ACTIVE_LOOP_DECODE_CONCURRENCY },
            )
          }),
        ).pipe(Effect.mapError(sessionError("listActiveLoops")), inWorkspace),
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
