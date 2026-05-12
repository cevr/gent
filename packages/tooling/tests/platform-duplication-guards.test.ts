import { describe, expect, test } from "bun:test"
import { findPlatformDuplicationViolations } from "../src/platform-duplication-guards"

describe("platform duplication guards", () => {
  test("ignores docs and tests", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/tests/runtime/example.test.ts",
        "const name = 'TurnEvent'",
      ),
    ).toEqual([])
  })

  test("flags deleted runtime bridge names in active source", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "const a = ExtensionRuntime",
          "const b = ExtensionTurnControl",
          "const c = TurnEvent",
          "const d = TurnEventUsage",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message: "ExtensionRuntime marker service is deleted; use explicit services",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 2,
        message: "ExtensionTurnControl mailbox is deleted; use the session runtime protocol",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 3,
        message: "TurnEvent duplicates Effect AI response parts",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 4,
        message: "TurnEvent duplicates Effect AI response parts",
      },
    ])
  })

  test("flags deleted storage subtag adapter", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/storage/example.ts",
        "const layer = subTagLayers(base)",
      ),
    ).toEqual([
      {
        file: "packages/core/src/storage/example.ts",
        line: 1,
        message: "Storage subtag adapter is deleted; use SqliteStorage composition roots",
      },
    ])
  })

  test("flags withX effect wrapper helpers", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "export const withThing = <A, E, R>(",
          "  effect: Effect.Effect<A, E, R>,",
          "  value: string,",
          ") => effect.pipe(Effect.annotateLogs({ value }))",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "`withX(effect, ...)` wrapper helpers are banned; expose a pipeable provider and call it from `.pipe(...)`",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "export const withThing = <A, E, R>(",
          "  eff: Effect.Effect<A, E, R>,",
          "  value: string,",
          ") => eff.pipe(Effect.annotateLogs({ value }))",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "`withX(effect, ...)` wrapper helpers are banned; expose a pipeable provider and call it from `.pipe(...)`",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "export const provideThing =",
          "  (value: string) =>",
          "  <A, E, R>(effect: Effect.Effect<A, E, R>) =>",
          "    effect.pipe(Effect.annotateLogs({ value }))",
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags withX wrappers around function invocations", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "yield* withWorkspace(submitTurn(operation))",
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "`withX(fn(...))` invocation style is banned; call the inner effect and pipe the wrapper (`fn(...).pipe(withX)`).",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "yield* withWorkspace(",
          "  Effect.gen(function* () {",
          "    yield* submitTurn(operation)",
          "  }),",
          ")",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "`withX(fn(...))` invocation style is banned; call the inner effect and pipe the wrapper (`fn(...).pipe(withX)`).",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "yield* submitTurn(operation).pipe(provideWorkspace)",
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "yield* run.pipe(withWideEvent(agentRunBoundary(agentName, sessionId)))",
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "yield* run.pipe(",
          "  Effect.tap(() => WideEvent.set({ sessionId, branchId })),",
          "  withWideEvent(rpcBoundary('message.send', requestId)),",
          ")",
        ].join("\n"),
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/storage/example.ts",
        "return yield* sql.withTransaction(saveMessage(message))",
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/openai/codex-transform.ts",
        "const withBody = rewriteCodexBody(withHeaders(req, headers))",
      ),
    ).toEqual([])
  })

  test("flags deleted public actor rpc path", () => {
    expect(findPlatformDuplicationViolations("packages/core/src/server/rpcs/actor.ts", "")).toEqual(
      [
        {
          file: "packages/core/src/server/rpcs/actor.ts",
          line: 1,
          message: "Public actor RPC surface is deleted; use product RPCs",
        },
      ],
    )

    expect(
      findPlatformDuplicationViolations("packages/core/src/server/rpcs/session.ts", ""),
    ).toEqual([])
  })

  test("does not flag the guard source itself", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/tooling/src/platform-duplication-guards.ts",
        ["ExtensionRuntime", "ctx.extension.request(ref)", "subTagLayers(base)"].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags session transport dto names only in the transport contract", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/transport-contract.ts",
        "export class SessionInfo {}",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/transport-contract.ts",
        line: 1,
        message: "Transport session DTOs mirror domain types",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/domain/example.ts",
        "export class SessionInfo {}",
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/transport-contract.ts",
        ["export class BranchInfo {}", "const runtime = ExtensionRuntime"].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/transport-contract.ts",
        line: 1,
        message: "Transport session DTOs mirror domain types",
      },
      {
        file: "packages/core/src/server/transport-contract.ts",
        line: 2,
        message: "ExtensionRuntime marker service is deleted; use explicit services",
      },
    ])
  })

  test("flags stale in-process extension rpc comments and calls", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/example.ts",
        ["ctx.extension.request(ref)", "// typed RPC helpers"].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/example.ts",
        line: 1,
        message: "In-process extension RPC is deleted; yield services or use public transport",
      },
      {
        file: "packages/extensions/src/example.ts",
        line: 2,
        message: "Host contexts no longer expose typed RPC helpers",
      },
    ])
  })

  test("flags reintroduced GentSpan tracer", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "const span = GentSpan.start()",
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message: "GentSpan tracer is deleted; use @effect/opentelemetry via Tracer service",
      },
    ])
  })

  test("flags destructive storage schema reset", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/storage/example.ts",
        "yield* resetIncompatibleStorageSchema()",
      ),
    ).toEqual([
      {
        file: "packages/core/src/storage/example.ts",
        line: 1,
        message: "Destructive schema reset is deleted; use SqliteMigrator migrations",
      },
    ])
  })

  test("flags LiveFile JSON KV pattern", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "const layer = AuthStorage.LiveFile(path)",
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message: "LiveFile JSON KV pattern is deleted; use KeyValueStore.layerFileSystem",
      },
    ])
  })

  test("flags reintroduced EventStore.Live = EventStore.Memory alias", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/example.ts",
        "EventStore.Live = EventStore.Memory",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/example.ts",
        line: 1,
        message:
          "EventStore.Live = EventStore.Memory alias is deleted; resolve EventStore explicitly per persistence mode",
      },
    ])

    // Direct EventStore.Memory references are legitimate (memory persistence
    // mode, test harness) and must not trip the guard.
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/dependencies.ts",
        "persistenceMode === 'memory' ? EventStore.Memory : Layer.provide(EventStoreLive, ...)",
      ),
    ).toEqual([])
  })

  test("flags Bun platform providers outside platform roots", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/dependencies.ts",
        "Layer.provide(Auth.Live(dir), BunPlatformLive)",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/dependencies.ts",
        line: 1,
        message: "Bun platform layers may only be provided by platform roots",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/server-root.ts",
        "const PlatformLayer = Layer.mergeAll(BunCronRuntimeLive, BunGentPlatformLive)",
      ),
    ).toEqual([])
  })

  test("flags deleted agent-loop dispatch infrastructure", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/agent/example.ts",
        [
          "const loops = loopsRef",
          "const semaphores = mutationSemaphoresRef",
          "type Event = LoopDriverEvent",
          "type Handle = LoopHandle",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 1,
        message: "Legacy agent-loop dispatch infrastructure is deleted; use AgentLoop actor state",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 2,
        message: "Legacy agent-loop dispatch infrastructure is deleted; use AgentLoop actor state",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 3,
        message: "Legacy agent-loop dispatch infrastructure is deleted; use AgentLoop actor state",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 4,
        message: "Legacy agent-loop dispatch infrastructure is deleted; use AgentLoop actor state",
      },
    ])
  })

  test("flags deleted runtime composer scope brands", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/agent/example.ts",
        [
          "const erased = eraseLayer(layer)",
          "const restored = restoreErasedLayer(erased)",
          "type Parent = ServerProfile",
          "type Child = CwdProfile",
          "type Leaf = EphemeralProfile",
          "const service = ServerProfileService",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 1,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 2,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 3,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 4,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 5,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
      {
        file: "packages/core/src/runtime/agent/example.ts",
        line: 6,
        message: "Legacy runtime composer scope brands are deleted; compose layers at the owner",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/agent/agent-runner.ts",
        "const layer = Layer.provideMerge(parent, child)",
      ),
    ).toEqual([])
  })

  test("flags deleted runtime composer module paths", () => {
    expect(findPlatformDuplicationViolations("packages/core/src/runtime/composer.ts", "")).toEqual([
      {
        file: "packages/core/src/runtime/composer.ts",
        line: 1,
        message: "Legacy runtime composer modules are deleted; use owner-local layer composition",
      },
    ])
    expect(
      findPlatformDuplicationViolations("packages/core/src/runtime/scope-brands.ts", ""),
    ).toEqual([
      {
        file: "packages/core/src/runtime/scope-brands.ts",
        line: 1,
        message: "Legacy runtime composer modules are deleted; use owner-local layer composition",
      },
    ])
    expect(
      findPlatformDuplicationViolations("packages/core/src/runtime/agent/agent-runner.ts", ""),
    ).toEqual([])
  })

  test("flags ephemeral root composition inside agent runner", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/agent/agent-runner.ts",
        [
          "const storage = SqliteStorage.MemoryWithSql()",
          "const runner = SingleRunner.layer({ runnerStorage: 'memory' })",
          "const runtime = SessionRuntime.Live({ baseSections: [] })",
          "const resources = ResourceManagerLive",
          "const extensions = buildExtensionLayers(resolved)",
          "const prompt = PromptPresenterLive",
          "const store = EventStoreLive",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/agent/agent-runner.ts",
        line: 1,
        message: "AgentRunner must use the ephemeral child root preset",
      },
      {
        file: "packages/core/src/runtime/agent/agent-runner.ts",
        line: 2,
        message: "AgentRunner must use the ephemeral child root preset",
      },
      {
        file: "packages/core/src/runtime/agent/agent-runner.ts",
        line: 3,
        message: "AgentRunner must use the ephemeral child root preset",
      },
      {
        file: "packages/core/src/runtime/agent/agent-runner.ts",
        line: 4,
        message: "AgentRunner must use the ephemeral child root preset",
      },
      {
        file: "packages/core/src/runtime/agent/agent-runner.ts",
        line: 5,
        message: "AgentRunner must use the ephemeral child root preset",
      },
      {
        file: "packages/core/src/runtime/agent/agent-runner.ts",
        line: 6,
        message: "AgentRunner must use the ephemeral child root preset",
      },
      {
        file: "packages/core/src/runtime/agent/agent-runner.ts",
        line: 7,
        message: "AgentRunner must use the ephemeral child root preset",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/agent/ephemeral-root.ts",
        "const storage = SqliteStorage.MemoryWithSql()",
      ),
    ).toEqual([])
  })

  test("flags deleted provider test statics outside language-model utilities", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/providers/example.ts",
        [
          "const a = Provider.Sequence([])",
          "const b = Provider.Signal(reply)",
          "const c = Provider.Debug()",
          "const d = Provider.Failing(error)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/providers/example.ts",
        line: 1,
        message:
          "Provider test statics are deleted outside language-model test utilities; use LanguageModelLayers",
      },
      {
        file: "packages/core/src/providers/example.ts",
        line: 2,
        message:
          "Provider test statics are deleted outside language-model test utilities; use LanguageModelLayers",
      },
      {
        file: "packages/core/src/providers/example.ts",
        line: 3,
        message:
          "Provider test statics are deleted outside language-model test utilities; use LanguageModelLayers",
      },
      {
        file: "packages/core/src/providers/example.ts",
        line: 4,
        message:
          "Provider test statics are deleted outside language-model test utilities; use LanguageModelLayers",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/test-utils/language-model.ts",
        "const a = Provider.Sequence([])",
      ),
    ).toEqual([])
  })

  test("flags deleted auth and sdk worker module paths", () => {
    expect(
      findPlatformDuplicationViolations("packages/core/src/domain/auth-storage.ts", ""),
    ).toEqual([
      {
        file: "packages/core/src/domain/auth-storage.ts",
        line: 1,
        message: "Legacy auth domain module is deleted; use domain/auth",
      },
    ])
    expect(findPlatformDuplicationViolations("packages/core/src/domain/auth.ts", "")).toEqual([])
    expect(findPlatformDuplicationViolations("packages/sdk/src/server-registry.ts", "")).toEqual([
      {
        file: "packages/sdk/src/server-registry.ts",
        line: 1,
        message:
          "SDK worker registry/http split is deleted; use server lock and server entrypoints",
      },
    ])
    expect(findPlatformDuplicationViolations("packages/sdk/src/server.ts", "")).toEqual([])
  })

  test("flags deleted worker port preallocation and lifecycle symbols", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/sdk/src/example.ts",
        [
          "const port = findOpenPort()",
          "const host = WORKER_HOST",
          "type S = WorkerLifecycleState",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/sdk/src/example.ts",
        line: 1,
        message: "Worker port preallocation is deleted; use server-selected ports",
      },
      {
        file: "packages/sdk/src/example.ts",
        line: 2,
        message: "Worker port preallocation is deleted; use server-selected ports",
      },
      {
        file: "packages/sdk/src/example.ts",
        line: 3,
        message: "WorkerLifecycleState is deleted; use the server lifecycle contract",
      },
    ])
  })

  test("flags deleted Bun.Glob fallback", () => {
    expect(
      findPlatformDuplicationViolations(
        "apps/tui/src/utils/example.ts",
        "const glob = new Bun.Glob(pattern)",
      ),
    ).toEqual([
      {
        file: "apps/tui/src/utils/example.ts",
        line: 1,
        message: "Bun.Glob fallback is deleted; use the FileIndex service",
      },
    ])
  })

  test("flags Bun.randomUUIDv7 outside the platform adapter", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/example.ts",
        "const id = Bun.randomUUIDv7()",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/example.ts",
        line: 1,
        message: "Bun.randomUUIDv7 is adapter-only; use GentPlatform.randomId",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        "const id = Bun.randomUUIDv7()",
      ),
    ).toEqual([])
  })

  test("flags host process and OS facts outside the platform adapter", () => {
    expect(
      findPlatformDuplicationViolations(
        "apps/server/src/main.ts",
        [
          "const pid = process.pid",
          "const runtime = process.execPath",
          "process.kill(pid, 'SIGTERM')",
          "const hostname = os.hostname()",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "apps/server/src/main.ts",
        line: 1,
        message: "Host process facts are adapter-only; use GentPlatform",
      },
      {
        file: "apps/server/src/main.ts",
        line: 2,
        message: "Host process facts are adapter-only; use GentPlatform",
      },
      {
        file: "apps/server/src/main.ts",
        line: 3,
        message: "Host process facts are adapter-only; use GentPlatform",
      },
      {
        file: "apps/server/src/main.ts",
        line: 4,
        message: "Host OS facts are adapter-only; use GentPlatform",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        ["const pid = process.pid", "const home = os.homedir()"].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags direct bun package imports in core/extensions sources", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/librarian/repo-explorer.ts",
        'import { $ } from "bun"',
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/librarian/repo-explorer.ts",
        line: 1,
        message:
          "Direct `bun` package imports are adapter-only; use ExtensionContext.Process or Effect platform services",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        "import { something } from 'bun'",
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "Direct `bun` package imports are adapter-only; use ExtensionContext.Process or Effect platform services",
      },
    ])

    // bun:test, bun:sqlite, and other subpath imports must remain legal
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        ['import { describe } from "bun:test"', 'import { Database } from "bun:sqlite"'].join("\n"),
      ),
    ).toEqual([])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        'import { $ } from "bun"',
      ),
    ).toEqual([])
  })

  test("flags protected package working directory and OS module facts", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          "const cwd = process.cwd()",
          "const fallback = globalThis.process.cwd()",
          'import os from "node:os"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "Host working directory facts are adapter-only; use RuntimeEnvironment or GentPlatform",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 2,
        message:
          "Host working directory facts are adapter-only; use RuntimeEnvironment or GentPlatform",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 3,
        message: "Host OS module imports are adapter-only; use GentPlatform",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/bad.ts",
        ['import os from "os"', "const cwd = process.cwd()"].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/bad.ts",
        line: 1,
        message: "Host OS module imports are adapter-only; use GentPlatform",
      },
      {
        file: "packages/extensions/src/bad.ts",
        line: 2,
        message:
          "Host working directory facts are adapter-only; use RuntimeEnvironment or GentPlatform",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        ['import os from "node:os"', "const cwd = process.cwd()"].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags protected node:crypto and node:url module imports", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/storage/example.ts",
        [
          'import { createHash } from "node:crypto"',
          'import { fileURLToPath } from "node:url"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/storage/example.ts",
        line: 1,
        message:
          "Host crypto module imports are adapter-only; yield GentPlatform and call platform.hash(...) or platform.randomBytes(...)",
      },
      {
        file: "packages/core/src/storage/example.ts",
        line: 2,
        message:
          "Host url module imports are adapter-only; yield GentPlatform and call platform.fileURLToPath(...)",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/bad.ts",
        ['import { randomBytes } from "crypto"', 'import { fileURLToPath } from "url"'].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/bad.ts",
        line: 1,
        message:
          "Host crypto module imports are adapter-only; yield GentPlatform and call platform.hash(...) or platform.randomBytes(...)",
      },
      {
        file: "packages/extensions/src/bad.ts",
        line: 2,
        message:
          "Host url module imports are adapter-only; yield GentPlatform and call platform.fileURLToPath(...)",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        [
          'import { createHash, randomBytes } from "node:crypto"',
          'import { fileURLToPath } from "node:url"',
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags every acquisition form for crypto/url specifiers", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          'import "node:crypto"',
          'const c = await import("node:crypto")',
          'const u = require("node:url")',
          'const s = require("url")',
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/core/src/runtime/example.ts",
        line: 1,
        message:
          "Host crypto module imports are adapter-only; yield GentPlatform and call platform.hash(...) or platform.randomBytes(...)",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 2,
        message:
          "Host crypto module imports are adapter-only; yield GentPlatform and call platform.hash(...) or platform.randomBytes(...)",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 3,
        message:
          "Host url module imports are adapter-only; yield GentPlatform and call platform.fileURLToPath(...)",
      },
      {
        file: "packages/core/src/runtime/example.ts",
        line: 4,
        message:
          "Host url module imports are adapter-only; yield GentPlatform and call platform.fileURLToPath(...)",
      },
    ])

    // Plain string usage of "crypto" or "url" as data (param names, log
    // messages, branded ids) must not trip the guard.
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/example.ts",
        [
          'const moduleName = "url"',
          'logger.info("crypto subsystem ready")',
          'type Tag = "node:crypto-fact"',
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags direct hash, randomBytes, and fileURLToPath calls in protected packages", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/memory/vault.ts",
        [
          "const h = createHash('sha256')",
          "const bytes = randomBytes(32)",
          "const p = fileURLToPath(url)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "packages/extensions/src/memory/vault.ts",
        line: 1,
        message:
          "Direct createHash() is adapter-only; yield GentPlatform and call platform.hash(algorithm, input)",
      },
      {
        file: "packages/extensions/src/memory/vault.ts",
        line: 2,
        message:
          "Direct randomBytes() is adapter-only; yield GentPlatform and call platform.randomBytes(n) (or use the Web Crypto global `crypto.getRandomValues` if you need a sync Uint8Array)",
      },
      {
        file: "packages/extensions/src/memory/vault.ts",
        line: 3,
        message:
          "Direct fileURLToPath() is adapter-only; yield GentPlatform and call platform.fileURLToPath(url)",
      },
    ])

    // Test-utils are exempt — they back the platform itself.
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/test-utils/example.ts",
        "const h = createHash('sha256')",
      ),
    ).toEqual([])

    // Adapter root is exempt.
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform-bun.ts",
        ["const h = createHash('sha256')", "const p = fileURLToPath(url)"].join("\n"),
      ),
    ).toEqual([])

    // The platform interface file (with JSDoc method references) is also exempt.
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/runtime/gent-platform.ts",
        ["// - randomBytes(n) — secure random", "// - fileURLToPath(url) — convert URL"].join("\n"),
      ),
    ).toEqual([])

    // Method calls on a platform instance are NOT bare calls — must not trip.
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/example.ts",
        [
          "yield* platform.hash('sha256', input)",
          "yield* platform.randomBytes(32)",
          "platform.fileURLToPath(url)",
          "gentPlatform.fileURLToPath(import.meta.resolve('x'))",
        ].join("\n"),
      ),
    ).toEqual([])
  })

  test("flags bare new URL(import.meta.url) as a hand-rolled fileURLToPath", () => {
    expect(
      findPlatformDuplicationViolations(
        "packages/core/src/server/example.ts",
        "const here = new URL(import.meta.url).pathname",
      ),
    ).toEqual([
      {
        file: "packages/core/src/server/example.ts",
        line: 1,
        message:
          "Bare `new URL(import.meta.url)` is a hand-rolled fileURLToPath; yield GentPlatform and call platform.fileURLToPath(import.meta.url)",
      },
    ])

    // Routed through the platform: NOT a hand-rolled path — must not trip.
    expect(
      findPlatformDuplicationViolations(
        "packages/extensions/src/example.ts",
        "const here = platform.fileURLToPath(import.meta.url)",
      ),
    ).toEqual([])
  })

  test("flags server entrypoints that fork the composition root", () => {
    expect(
      findPlatformDuplicationViolations(
        "apps/server/src/main.ts",
        [
          'import { createDependencies } from "@gent/core-internal/server/dependencies.js"',
          'import { buildServerRoutes } from "@gent/core-internal/server/server-routes.js"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        file: "apps/server/src/main.ts",
        line: 1,
        message: "Server entrypoints must use server-root instead of hand-composing app services",
      },
      {
        file: "apps/server/src/main.ts",
        line: 2,
        message: "Server entrypoints must use server-root instead of hand-composing app services",
      },
    ])

    expect(
      findPlatformDuplicationViolations(
        "packages/sdk/src/server.ts",
        'import { buildServerRoot } from "@gent/core-internal/server/server-root.js"',
      ),
    ).toEqual([])
  })
})
