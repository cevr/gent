import { describe, it, expect } from "effect-bun-test"
import { Deferred, Effect, Layer, Stream } from "effect"
import { createSequenceProvider, textStep } from "@gent/core/debug/provider"
import { ModelId } from "@gent/core/domain/model"
import { BranchId, MessageId, SessionId, ToolCallId } from "@gent/core/domain/ids"
import { Branch, Message, Session, TextPart } from "@gent/core/domain/message"
import { EventStore, EventStoreError } from "@gent/core/domain/event"
import { EventPublisher } from "@gent/core/domain/event-publisher"
import type { LoadedExtension } from "@gent/core/domain/extension"
import type { ProjectionContribution } from "@gent/core/domain/projection"
import { Provider } from "@gent/core/providers/provider"
import { SessionRuntime } from "../../src/runtime/session-runtime"
import { MachineEngine } from "../../src/runtime/extensions/resource-host/machine-engine"
import { SessionCwdRegistry } from "../../src/runtime/session-cwd-registry"
import { SessionCommands } from "@gent/core/server/session-commands"
import { BranchStorage } from "@gent/core/storage/branch-storage"
import { MessageStorage } from "@gent/core/storage/message-storage"
import { SessionStorage } from "@gent/core/storage/session-storage"
import { Storage, subTagLayers } from "@gent/core/storage/sqlite-storage"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { waitFor } from "@gent/core/test-utils/fixtures"
import { Gent } from "@gent/sdk"
import { e2ePreset } from "../extensions/helpers/test-preset"

const makeClient = (reply = "ok") =>
  Effect.gen(function* () {
    const { layer: providerLayer } = yield* createSequenceProvider([textStep(reply)])
    return yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
  })

const collectSessionEvents = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const closed = yield* Deferred.make<void>()

    yield* stream.pipe(
      Stream.runForEach(() => Deferred.succeed(ready, undefined).pipe(Effect.ignore)),
      Effect.ensuring(Deferred.succeed(closed, undefined).pipe(Effect.ignore)),
      Effect.forkScoped,
    )

    yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
    return closed
  })

const failingPublisherLayer = Layer.succeed(EventPublisher, {
  append: () => Effect.fail(new EventStoreError({ message: "publish failed" })),
  deliver: () => Effect.void,
  publish: () => Effect.fail(new EventStoreError({ message: "publish failed" })),
  terminateSession: () => Effect.void,
})

const failingSessionCommandsLayer = () => {
  const storageLayer = Storage.MemoryWithSql()
  const deps = Layer.mergeAll(
    storageLayer,
    subTagLayers(storageLayer),
    SessionRuntime.Test(),
    EventStore.Memory,
    failingPublisherLayer,
    Provider.Debug(),
    MachineEngine.Test(),
    SessionCwdRegistry.Test(),
  )
  return Layer.provideMerge(SessionCommands.Live, deps)
}

const postCommitFailingSessionCommandsLayer = () => {
  const storageLayer = Storage.MemoryWithSql()
  const eventStoreLayer = EventStore.Memory
  const postCommitFailingPublisherLayer = Layer.effect(
    EventPublisher,
    Effect.gen(function* () {
      const eventStore = yield* EventStore
      return EventPublisher.of({
        append: (event) => eventStore.append(event),
        deliver: () => Effect.fail(new EventStoreError({ message: "deliver failed" })),
        publish: (event) =>
          Effect.gen(function* () {
            const envelope = yield* eventStore.append(event)
            yield* Effect.fail(new EventStoreError({ message: "deliver failed" }))
            return envelope
          }),
        terminateSession: () => Effect.void,
      })
    }),
  ).pipe(Layer.provide(eventStoreLayer))
  const deps = Layer.mergeAll(
    storageLayer,
    subTagLayers(storageLayer),
    SessionRuntime.Test(),
    eventStoreLayer,
    postCommitFailingPublisherLayer,
    Provider.Debug(),
    MachineEngine.Test(),
    SessionCwdRegistry.Test(),
  )
  return Layer.provideMerge(SessionCommands.Live, deps)
}

const parentToolCallProbeProjection: ProjectionContribution<string | undefined> = {
  id: "parent-tool-call-probe",
  query: (ctx) => Effect.succeed(ctx.turn.parentToolCallId),
  prompt: (parentToolCallId) =>
    parentToolCallId === undefined
      ? []
      : [
          {
            id: "parent-tool-call-probe",
            content: `parentToolCallId:${parentToolCallId}`,
            priority: 45,
          },
        ],
}

const parentToolCallProbeExtension: LoadedExtension = {
  manifest: { id: "parent-tool-call-probe" },
  scope: "builtin",
  sourcePath: "test",
  contributions: { projections: [parentToolCallProbeProjection] },
}

describe("session command persistence", () => {
  it.live("rolls back session and branch creation when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage

      const exit = yield* Effect.exit(commands.createSession({ cwd: "/tmp/rollback" }))

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions()).toHaveLength(0)
      expect(yield* branches.listBranches(SessionId.make("missing"))).toHaveLength(0)
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("rolls back forked branch and copied messages when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const messages = yield* MessageStorage
      const sessionId = SessionId.make("session-rollback")
      const branchId = BranchId.make("branch-source")
      const messageId = MessageId.make("message-source")
      const now = new Date()

      yield* sessions.createSession(
        new Session({
          id: sessionId,
          name: "rollback",
          activeBranchId: branchId,
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* branches.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
      yield* messages.createMessage(
        Message.cases.regular.make({
          id: messageId,
          sessionId,
          branchId,
          role: "user",
          parts: [new TextPart({ type: "text", text: "seed" })],
          createdAt: now,
        }),
      )

      const exit = yield* Effect.exit(
        commands.forkBranch({
          sessionId,
          fromBranchId: branchId,
          atMessageId: messageId,
          name: "fork",
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* branches.listBranches(sessionId)).toHaveLength(1)
      expect(yield* messages.listMessages(branchId)).toHaveLength(1)
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("rolls back session rename when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const sessionId = SessionId.make("session-rename-rollback")
      const branchId = BranchId.make("branch-rename-rollback")
      const now = new Date()

      yield* sessions.createSession(
        new Session({
          id: sessionId,
          name: "before",
          activeBranchId: branchId,
          createdAt: now,
          updatedAt: now,
        }),
      )

      const exit = yield* Effect.exit(commands.renameSession({ sessionId, name: "after" }))

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.name).toBe("before")
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("rolls back active branch switch when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      const sessionId = SessionId.make("session-switch-rollback")
      const fromBranchId = BranchId.make("branch-switch-from")
      const toBranchId = BranchId.make("branch-switch-to")
      const now = new Date()

      yield* sessions.createSession(
        new Session({
          id: sessionId,
          name: "switch",
          activeBranchId: fromBranchId,
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* branches.createBranch(new Branch({ id: fromBranchId, sessionId, createdAt: now }))
      yield* branches.createBranch(new Branch({ id: toBranchId, sessionId, createdAt: now }))

      const exit = yield* Effect.exit(
        commands.switchBranch({
          sessionId,
          fromBranchId,
          toBranchId,
          summarize: false,
        }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.activeBranchId).toBe(fromBranchId)
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("rolls back reasoning setting when event publication fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage
      const sessionId = SessionId.make("session-settings-rollback")
      const branchId = BranchId.make("branch-settings-rollback")
      const now = new Date()

      yield* sessions.createSession(
        new Session({
          id: sessionId,
          name: "settings",
          activeBranchId: branchId,
          createdAt: now,
          updatedAt: now,
        }),
      )

      const exit = yield* Effect.exit(
        commands.updateSessionReasoningLevel({ sessionId, reasoningLevel: "high" }),
      )

      expect(exit._tag).toBe("Failure")
      expect((yield* sessions.getSession(sessionId))?.reasoningLevel).toBeUndefined()
    }).pipe(Effect.provide(failingSessionCommandsLayer())),
  )

  it.live("does not roll back committed rows when post-commit delivery fails", () =>
    Effect.gen(function* () {
      const commands = yield* SessionCommands
      const sessions = yield* SessionStorage

      const exit = yield* Effect.exit(commands.createSession({ cwd: "/tmp/post-commit" }))

      expect(exit._tag).toBe("Failure")
      expect(yield* sessions.listSessions()).toHaveLength(1)
    }).pipe(Effect.provide(postCommitFailingSessionCommandsLayer())),
  )
})

describe("session.delete", () => {
  it.live("closes session event streams and removes the session from public queries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })
        const closed = yield* collectSessionEvents(
          client.session.events({
            sessionId: created.sessionId,
          }),
        )

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* Deferred.await(closed).pipe(Effect.timeout("5 seconds"))

        const deleted = yield* client.session.get({ sessionId: created.sessionId })
        const sessions = yield* client.session.list()

        expect(deleted).toBeNull()
        expect(sessions.some((session) => session.id === created.sessionId)).toBe(false)
      }),
    ),
  )

  it.live("is idempotent when deleting an already deleted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* makeClient()
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.session.delete({ sessionId: created.sessionId })
        yield* client.session.delete({ sessionId: created.sessionId })
        const deleted = yield* client.session.get({ sessionId: created.sessionId })

        expect(deleted).toBeNull()
      }),
    ),
  )
})

describe("message.send", () => {
  it.live(
    "persists the user message and assistant reply through the public snapshot contract",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const userText = "hello from acceptance"
          const assistantText = "acceptance reply"
          const { client } = yield* makeClient(assistantText)
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: userText,
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === assistantText),
              ),
            5_000,
            "assistant reply in session snapshot",
          )

          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "user" &&
                message.parts.some((part) => part.type === "text" && part.text === userText),
            ),
          ).toBe(true)
          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          ).toBe(true)
        }),
      ),
  )

  it.live("applies runSpec overrides through the public message contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const assistantText = "runSpec acceptance reply"
        const { layer: providerLayer, controls } = yield* createSequenceProvider([
          {
            ...textStep(assistantText),
            assertRequest: (request) => {
              expect(request.model).toBe("custom/model")
              expect(request.reasoning).toBe("high")
            },
          },
        ])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "use run spec",
          runSpec: {
            overrides: {
              modelId: ModelId.make("custom/model"),
              reasoningEffort: "high",
              systemPromptAddendum: "Extra public contract instructions",
            },
            tags: ["acceptance"],
          },
        })

        const snapshot = yield* waitFor(
          client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
          (current) =>
            current.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          5_000,
          "assistant reply from runSpec turn",
        )

        expect(
          snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.parts.some((part) => part.type === "text" && part.text === assistantText),
          ),
        ).toBe(true)
        yield* controls.assertDone()
      }),
    ),
  )

  it.live("threads runSpec parentToolCallId through the public message contract", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const assistantText = "parent tool call acceptance reply"
        const parentToolCallId = ToolCallId.make("tc-parent-acceptance")
        const { layer: providerLayer, controls } = yield* createSequenceProvider([
          {
            ...textStep(assistantText),
            assertRequest: (request) => {
              expect(JSON.stringify(request.prompt)).toContain(
                `parentToolCallId:${parentToolCallId}`,
              )
            },
          },
        ])
        const { client } = yield* Gent.test(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [],
            extensions: [parentToolCallProbeExtension],
          }),
        )
        const created = yield* client.session.create({ cwd: process.cwd() })

        yield* client.message.send({
          sessionId: created.sessionId,
          branchId: created.branchId,
          content: "thread parent tool call id",
          runSpec: { parentToolCallId },
        })

        yield* waitFor(
          client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          }),
          (current) =>
            current.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && part.text === assistantText),
            ),
          5_000,
          "assistant reply from parentToolCallId turn",
        )

        yield* controls.assertDone()
      }),
    ),
  )
})
