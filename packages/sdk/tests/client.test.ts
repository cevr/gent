import { describe, expect, it, test } from "effect-bun-test"
import { Effect, Layer, Predicate, Random, Schema } from "effect"
import { BunChildProcessSpawner, BunServices } from "@effect/platform-bun"
import { getToolId } from "@gent/core/extensions/api"
import { BuiltinExtensions } from "@gent/extensions"
import {
  collectTestContributions,
  makeTempDirectoryScoped,
  waitFor,
  projectMessagesWithToolInteractions,
} from "@gent/core/test-utils"
import {
  GentPlatform,
  WORKSPACE_ID_HEADER,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
} from "@gent/core/host"
import * as Prompt from "effect/unstable/ai/Prompt"
import { Gent } from "../src/client"
import type { Message as DomainMessage } from "@gent/core/protocol"
import {
  BranchId,
  MessageId,
  SessionId,
  ToolCallId,
  dateFromMillis,
  Message,
  messagePartsText,
} from "@gent/core/protocol"

// ── client helpers ──────────────────────────────────────────────────────────

describe("sdk client helpers", () => {
  test("canonical tool interactions expose running calls", () => {
    const message = Message.cases.regular.make({
      id: MessageId.make("m1"),
      sessionId: SessionId.make("s1"),
      branchId: BranchId.make("b1"),
      role: "assistant",
      parts: [
        Prompt.toolCallPart({
          id: ToolCallId.make("tc1"),
          name: "read",
          params: { path: "/foo" },
          providerExecuted: false,
        }),
      ],
      createdAt: dateFromMillis(0),
    })
    const projected = projectMessagesWithToolInteractions([message])[0]
    expect(projected?.toolInteractions.length).toBe(1)
    expect(projected?.toolInteractions[0]?.id).toBe(ToolCallId.make("tc1"))
    expect(projected?.toolInteractions[0]?.toolName).toBe("read")
    expect(projected?.toolInteractions[0]?.status).toBe("running")
  })

  test("canonical tool interactions include completed results", () => {
    const messages: DomainMessage[] = [
      Message.cases.regular.make({
        id: MessageId.make("m1"),
        sessionId: SessionId.make("s1"),
        branchId: BranchId.make("b1"),
        role: "assistant",
        parts: [
          Prompt.toolCallPart({
            id: ToolCallId.make("tc1"),
            name: "read",
            params: { path: "/foo" },
            providerExecuted: false,
          }),
        ],
        createdAt: dateFromMillis(0),
      }),
      Message.cases.regular.make({
        id: MessageId.make("m2"),
        sessionId: SessionId.make("s1"),
        branchId: BranchId.make("b1"),
        role: "tool",
        parts: [
          Prompt.toolResultPart({
            id: ToolCallId.make("tc1"),
            name: "read",
            isFailure: false,
            providerExecuted: false,
            result: "file contents",
          }),
        ],
        createdAt: dateFromMillis(1),
      }),
    ]
    const projected = projectMessagesWithToolInteractions(messages)[0]
    expect(projected?.toolInteractions[0]?.status).toBe("completed")
    expect(projected?.toolInteractions[0]?.output).toBe("file contents")
  })

  test("workspace id is a stable hash of canonical cwd", () => {
    expect(workspaceIdForCwd("/tmp/gent/../gent")).toBe(workspaceIdForCwd("/tmp/gent"))
    expect(workspaceIdForCwd("/tmp/gent")).toMatch(/^[a-f0-9]{64}$/)
    expect(workspaceHeadersForCwd("/tmp/gent")[WORKSPACE_ID_HEADER]).toBe(
      workspaceIdForCwd("/tmp/gent"),
    )
  })
})

// ── server options ──────────────────────────────────────────────────────────

/**
 * `Gent.server` is the single server composition root. These tests pin the
 * options `apps/server/src/main.ts` needs from it — a fixed port and idle
 * shutdown — so the launcher never rebuilds a second root to get them back.
 */

const ServerIdentity = Schema.Struct({
  serverId: Schema.String,
  pid: Schema.Finite,
  hostname: Schema.String,
  dbPath: Schema.String,
  buildFingerprint: Schema.String,
})

/** The served keys, as data: decoding preserves whatever the route sent. */
const IdentityKeys = Schema.Record(Schema.String, Schema.Unknown)

const fetchIdentityJson = (baseUrl: string) =>
  Effect.promise(() => Bun.fetch(`${baseUrl}/_gent/identity`)).pipe(
    Effect.andThen((response) => Effect.promise(() => response.json())),
  )

const fetchIdentity = (baseUrl: string) =>
  fetchIdentityJson(baseUrl).pipe(Effect.andThen(Schema.decodeUnknownEffect(ServerIdentity)))

describe("Gent.server options", () => {
  it.live(
    "binds the requested port and publishes its identity",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dataDir = yield* makeTempDirectoryScoped("gent-server-options-")
          const port = yield* Random.nextIntBetween(20_100, 21_000)
          const server = yield* Gent.server({
            cwd: dataDir,
            port,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })

          expect(server.url).toBe(`http://127.0.0.1:${port}/rpc`)

          const identity = yield* fetchIdentity(`http://127.0.0.1:${port}`)
          expect(identity.serverId.length).toBeGreaterThan(0)

          // Registry validation compares the stable identity. A restart-varying
          // field on this route would make every comparison a mismatch.
          const keys = yield* fetchIdentityJson(`http://127.0.0.1:${port}`).pipe(
            Effect.andThen(Schema.decodeUnknownEffect(IdentityKeys)),
          )
          expect(Object.keys(keys).sort()).toEqual([
            "buildFingerprint",
            "dbPath",
            "hostname",
            "pid",
            "serverId",
          ])
        }).pipe(Effect.timeout("20 seconds")),
      ),
    30_000,
  )
})

interface SeededCall {
  readonly name: string
  readonly params: unknown
}

/**
 * The seeded calls no shipped tool accepts: an unknown tool id, or params the
 * tool's own schema rejects. Tools come from the builtin extensions' setup.
 */
const rejectedCalls = (calls: ReadonlyArray<SeededCall>) =>
  Effect.gen(function* () {
    const tools = new Map<string, Schema.Constraint>()
    for (const extension of BuiltinExtensions) {
      const contributions = yield* collectTestContributions(extension.setup)
      for (const tool of contributions.tools ?? []) {
        tools.set(getToolId(tool), tool.parametersSchema)
      }
    }
    const rejected: string[] = []
    for (const call of calls) {
      const schema = tools.get(call.name)
      if (Predicate.isUndefined(schema)) {
        rejected.push(`${call.name}: no shipped tool has this id`)
        continue
      }
      // The seeded tools' params are plain structs: their type side is their JSON.
      if (!Schema.is(schema)(call.params)) rejected.push(`${call.name}: params do not fit`)
    }
    return rejected
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        BunChildProcessSpawner.layer.pipe(Layer.provide(BunServices.layer)),
        GentPlatform.Test(),
      ),
    ),
  )

describe("Gent.server debug playground", () => {
  it.live(
    "seeds only calls to shipped tools, with params those tools accept",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDirectoryScoped("gent-debug-seed-")
          const server = yield* Gent.server({
            cwd,
            debug: true,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })
          const { client } = yield* Gent.client(server, { cwd })
          const [session] = yield* client.session.list()
          const branchId = yield* Effect.fromNullishOr(session?.activeBranchId)
          const messages = yield* client.message.list({ branchId })
          const calls = messages.flatMap((message) =>
            message.parts.filter((part) => part.type === "tool-call"),
          )
          expect(calls.length).toBeGreaterThan(0)
          expect(yield* rejectedCalls(calls)).toEqual([])
        }).pipe(Effect.timeout("20 seconds")),
      ),
    30_000,
  )
})

describe("Gent.server workspace isolation", () => {
  it.live(
    "a single owned server isolates persisted session reads by client workspace",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwdA = yield* makeTempDirectoryScoped("gent-server-options-")
          const cwdB = yield* makeTempDirectoryScoped("gent-server-options-")
          const server = yield* Gent.server({
            cwd: cwdA,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })
          const clientA = (yield* Gent.client(server, { cwd: cwdA })).client
          const clientB = (yield* Gent.client(server, { cwd: cwdB })).client

          const created = yield* clientA.session.create({ name: "Workspace A", cwd: cwdA })
          yield* clientA.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "workspace-a-message",
          })

          yield* waitFor(clientA.message.list({ branchId: created.branchId }), (messages) =>
            messages.some((message) => messagePartsText(message.parts) === "workspace-a-message"),
          )

          const sessionsB = yield* clientB.session.list()
          const sessionB = yield* clientB.session.get({ sessionId: created.sessionId })
          const branchesB = yield* clientB.branch.list({ sessionId: created.sessionId })
          const messagesB = yield* clientB.message.list({ branchId: created.branchId })
          const snapshotB = yield* Effect.result(
            clientB.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
          )

          expect(sessionsB.map((session) => session.id)).not.toContain(created.sessionId)
          expect(sessionB).toBeNull()
          expect(branchesB).toEqual([])
          expect(messagesB).toEqual([])
          expect(snapshotB._tag).toBe("Failure")
        }).pipe(Effect.timeout("20 seconds")),
      ),
    30_000,
  )
})
