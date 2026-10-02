import { describe, expect, it } from "effect-bun-test"
import { ConfigProvider, Crypto, Effect, FileSystem, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { BunServices } from "@effect/platform-bun"
import { defineExtension, ExtensionHost, request } from "@gent/core/extensions/api"
import { BuiltinExtensions } from "@gent/extensions"
import {
  freePort,
  makeTempDirectoryScoped,
  serveModelCatalogFixture,
  waitFor,
} from "@gent/core/test-utils"
import { SessionStorage } from "@gent/core/host"
import { Gent } from "../src/client"
import { Session, SessionId, dateFromMillis, messagePartsText } from "@gent/core/protocol"

// ── server options ──────────────────────────────────────────────────────────

/**
 * `Gent.server` is the single server composition root. These tests pin the
 * options `gent server start` needs from it, such as a fixed port, so the
 * launcher never rebuilds a second root to get them back.
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
  HttpClient.get(`${baseUrl}/_gent/identity`).pipe(
    Effect.flatMap((response) => response.json),
    Effect.provide(FetchHttpClient.layer),
    Effect.orDie,
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
          const port = yield* freePort
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/

// A user-shaped extension whose setup mints an id with Effect `Crypto`. The
// TUI and `gent server start` both build their root through `Gent.server`.
const cryptoSetupExtension = defineExtension({
  id: "crypto-setup",
  setup: Effect.gen(function* () {
    const id = yield* (yield* Crypto.Crypto).randomUUIDv7.pipe(Effect.orDie)
    const host = yield* ExtensionHost
    yield* host.register(
      "request",
      request({
        id: "minted",
        slash: { name: "minted", description: id },
        description: id,
        input: Schema.String,
        output: Schema.Void,
        execute: () => Effect.void,
      }),
    )
  }),
})

describe("Gent.server extension setup", () => {
  it.live(
    "gives setup the Crypto service",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDirectoryScoped("gent-server-crypto-")
          const server = yield* Gent.server({
            cwd,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
            extensions: [...BuiltinExtensions, cryptoSetupExtension],
          })
          const { client } = yield* Gent.client(server, { cwd })
          const { sessionId } = yield* client.session.create({ cwd })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          const minted = commands.find((command) => command.name === "minted")
          expect(minted?.description).toMatch(UUID_PATTERN)
        }).pipe(Effect.timeout("20 seconds")),
      ),
    30_000,
  )
})

describe("Gent.server seed", () => {
  it.live(
    "a seed writes to the server's storage in its workspace before the server returns",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDirectoryScoped("gent-server-seed-")
          const at = dateFromMillis(1_000)
          const seed = Effect.gen(function* () {
            const sessions = yield* SessionStorage
            yield* sessions.createSession(
              new Session({
                id: SessionId.make("seeded-session"),
                name: "seeded",
                cwd,
                createdAt: at,
                updatedAt: at,
              }),
            )
          }).pipe(Effect.orDie)
          const server = yield* Gent.server({
            cwd,
            seed,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })
          const { client } = yield* Gent.client(server, { cwd })
          const listed = yield* client.session.list()
          expect(listed.map((session) => session.name)).toEqual(["seeded"])
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

  it.live(
    "a client built from a URL names the workspace of its cwd, or of the process cwd",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwdA = yield* makeTempDirectoryScoped("gent-url-client-")
          const cwdB = yield* makeTempDirectoryScoped("gent-url-client-")
          const server = yield* Gent.server({
            cwd: cwdA,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
          })
          const clientA = (yield* Gent.client(server.url, { cwd: cwdA })).client
          const clientB = (yield* Gent.client(server.url, { cwd: cwdB })).client
          const clientHere = (yield* Gent.client(server.url)).client

          const created = yield* clientA.session.create({ name: "Workspace A", cwd: cwdA })
          const ids = (sessions: ReadonlyArray<{ readonly id: string }>) =>
            sessions.map((session) => session.id)
          expect(ids(yield* clientA.session.list())).toContain(created.sessionId)
          expect(ids(yield* clientB.session.list())).not.toContain(created.sessionId)
          expect(ids(yield* clientHere.session.list())).not.toContain(created.sessionId)
          const here = yield* clientHere.session.create({ name: "Here", cwd: process.cwd() })
          expect(ids(yield* clientHere.session.list())).toContain(here.sessionId)
          expect(ids(yield* clientA.session.list())).not.toContain(here.sessionId)
        }).pipe(Effect.timeout("20 seconds")),
      ),
    30_000,
  )
})

/** The op receipts a cell result carries. */
const CellReceipts = Schema.Struct({
  operations: Schema.Array(Schema.Struct({ tool: Schema.String, summary: Schema.String })),
})

describe("Gent.provider.mock tool scenario", () => {
  it.live(
    "a message asking for debug tools runs real tools over several steps, then answers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* makeTempDirectoryScoped("gent-debug-tools-")
          // A turn reads its model's catalog entry: the server reads the
          // fixture catalog from a loopback listener, never models.dev.
          const catalogOrigin = yield* serveModelCatalogFixture
          const server = yield* Gent.server({
            cwd,
            state: Gent.state.memory(),
            provider: Gent.provider.mock(),
            extensions: BuiltinExtensions,
          }).pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { GENT_MODEL_CATALOG_URL: catalogOrigin } }),
              ),
            ),
          )
          const { client } = yield* Gent.client(server, { cwd })
          const { sessionId, branchId } = yield* client.session.create({ cwd })
          yield* client.message.send({ sessionId, branchId, content: "debug tools please" })

          const messages = yield* waitFor(
            client.message.list({ branchId }),
            (all) => all.some((message) => messagePartsText(message.parts).includes("d.ts failed")),
            20_000,
          )
          // The default surface narrows to cell: each step is one cell whose ops ran for real.
          const ops = messages
            .filter((message) => message.role === "tool")
            .flatMap((message) => message.parts)
            .flatMap((part) => {
              if (part.type !== "tool-result") return []
              return Option.match(Schema.decodeUnknownOption(CellReceipts)(part.result), {
                onNone: () => [],
                onSome: (receipts) => receipts.operations,
              })
            })
          expect(ops.map((op) => op.tool)).toEqual([
            "bash",
            "read",
            "read",
            "read",
            "grep",
            "edit",
            "bash",
          ])
          expect(ops.at(-1)?.summary).toBe("exit 2 · 1 line")
          const fs = yield* FileSystem.FileSystem
          const edited = yield* fs.readFileString(`${cwd}/gent-debug-tools/a.ts`)
          expect(edited).toBe('export const greeting = "hello, world"\n// TODO: say goodbye\n')
          const reasoning = messages.flatMap((message) =>
            message.parts.filter((part) => part.type === "reasoning"),
          )
          expect(reasoning).toHaveLength(6)
        }).pipe(Effect.provide(BunServices.layer), Effect.timeout("28 seconds")),
      ),
    30_000,
  )
})
