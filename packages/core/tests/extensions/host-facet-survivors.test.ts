/**
 * Host facet survivor regression suite.
 *
 * After deleting 9 unused `ExtensionSession` CRUD methods in W33-C9.5,
 * `ctx.Session.listBranches` and the `requireCurrentAgent` helper remain as the
 * two non-trivial host-wired behaviors with no other direct test coverage.
 * The RPC suites exercise the durable mutation surface from the public
 * RPC angle; these tests pin the host-facet shape from the extension
 * angle.
 */
import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Layer, Option, Path, Schema } from "effect"
import { makeExtensionHostContextProvider } from "../../src/runtime/make-extension-host-context.js"
import { BranchStorage, SessionStorage, SqliteStorage } from "../../src/storage/storage.js"
import { noBranchTools } from "../../src/runtime/agent/tools.js"
import { BranchId, SessionId } from "../../src/domain/ids.js"
import { AgentName } from "../../src/domain/agent.js"
import { requireCurrentAgent, ExtensionServiceError } from "@gent/core/extensions/api"
import { provideExtensionServices } from "../../src/domain/extension.js"
import { dateFromMillis, Branch, Session } from "../../src/domain/message.js"
import { testExtensionFiles, testToolContext } from "../../src/test-utils/index.js"
import { resolveExtensions } from "../../src/runtime/extension-host.js"
import { testHostFacts } from "../../src/test-utils"

const SESSION_ID = SessionId.make("test-session")
const BRANCH_ID = BranchId.make("test-branch")
const FIXTURE_DATE = dateFromMillis(0)
const EMPTY_RESOLVED_EXTENSIONS = resolveExtensions([])

describe("host facet survivors after C9.5 prune", () => {
  it.live(
    "requireCurrentAgent fails with typed ExtensionServiceError when the agent is missing",
    () =>
      Effect.gen(function* () {
        const base = testToolContext()
        const exit = yield* Effect.exit(
          provideExtensionServices(
            {
              ...base,
              agentName: AgentName.make("missing-agent"),
              Agent: { ...base.Agent, listAgents: Effect.succeed([]) },
            },
            requireCurrentAgent,
          ),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        const error = Cause.findErrorOption(exit.cause)
        expect(Option.isSome(error)).toBe(true)
        if (!Option.isSome(error)) return
        expect(Schema.is(ExtensionServiceError)(error.value)).toBe(true)
        if (!Schema.is(ExtensionServiceError)(error.value)) return
        expect(error.value.service).toBe("ExtensionAgent")
        expect(error.value.operation).toBe("require")
        expect(error.value.message).toBe('Agent "missing-agent" not found in registry')
      }),
  )

  it.live("ctx.Session.listBranches returns branches for the current session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStorage
      const branches = yield* BranchStorage
      yield* sessions.createSession(
        new Session({
          id: SESSION_ID,
          name: "test",
          cwd: "/tmp",
          createdAt: FIXTURE_DATE,
          updatedAt: FIXTURE_DATE,
        }),
      )
      yield* branches.createBranch(
        new Branch({ id: BRANCH_ID, sessionId: SESSION_ID, createdAt: FIXTURE_DATE }),
      )
      const provider = yield* makeExtensionHostContextProvider({
        host: testHostFacts().host,
        extensionRegistry: {
          extensionHooks: EMPTY_RESOLVED_EXTENSIONS.extensionHooks,
          getResolved: () => EMPTY_RESOLVED_EXTENSIONS,
        },
      })
      const ctx = provider.forRun({ sessionId: SESSION_ID, branchId: BRANCH_ID })
      const listed = yield* ctx.Session.listBranches
      expect(listed).toHaveLength(1)
      expect(listed[0]!.id).toBe(BRANCH_ID)
    }).pipe(
      Effect.provide(SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations)),
    ),
  )
})

describe("test Files facet path parity", () => {
  // The test facet used to spell posix rules out by hand. It resolved a
  // relative path from `/` rather than the process cwd, and it dropped a
  // leading `..` from a join, so a test could pass against rules production
  // never applies. Both facets now read the same `Path` service.
  it.live("resolves and joins exactly as the production facet does", () =>
    Effect.gen(function* () {
      const provider = yield* makeExtensionHostContextProvider({
        host: testHostFacts().host,
        extensionRegistry: {
          extensionHooks: EMPTY_RESOLVED_EXTENSIONS.extensionHooks,
          getResolved: () => EMPTY_RESOLVED_EXTENSIONS,
        },
      })
      const production = provider.forRun({ sessionId: SESSION_ID, branchId: BRANCH_ID }).Files
      const stub = testExtensionFiles()

      // A relative path resolves from the process cwd, not from the root.
      expect(stub.resolve("relative.txt")).toBe(production.resolve("relative.txt"))
      expect(stub.resolve("relative.txt").startsWith(process.cwd())).toBe(true)
      expect(stub.resolve("relative.txt")).not.toBe("/relative.txt")

      // A leading `..` survives a relative join instead of being swallowed.
      expect(stub.join("..", "file")).toBe(production.join("..", "file"))
      expect(stub.join("..", "file")).toBe("../file")

      // The rest of the surface agrees too.
      expect(stub.resolve("/base", "sub")).toBe(production.resolve("/base", "sub"))
      expect(stub.join("/a", "b", "..", "c")).toBe(production.join("/a", "b", "..", "c"))
      expect(stub.dirname("/a/b/c.txt")).toBe(production.dirname("/a/b/c.txt"))
      expect(stub.dirname("bare.txt")).toBe(production.dirname("bare.txt"))
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteStorage.TestWithSql(noBranchTools.storage, noBranchTools.migrations),
          Path.layer,
        ),
      ),
    ),
  )
})
