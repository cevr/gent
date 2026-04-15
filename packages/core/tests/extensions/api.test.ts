import { describe, test, expect, beforeAll } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { extension } from "@gent/core/extensions/api"
import { AgentRunSpawned } from "@gent/core/domain/event"
import { resolveExtensions, ExtensionRegistry } from "@gent/core/runtime/extensions/registry"
import { ToolRunner } from "@gent/core/runtime/agent/tool-runner"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ExtensionStateRuntime } from "@gent/core/runtime/extensions/state-runtime"
import { spawnMachineExtensionRef } from "@gent/core/runtime/extensions/spawn-machine-ref"
import { ExtensionTurnControl } from "@gent/core/runtime/extensions/turn-control"
import { Permission } from "@gent/core/domain/permission"
import { ApprovalService } from "@gent/core/runtime/approval-service"
import { ToolCallId, SessionId, BranchId } from "@gent/core/domain/ids"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import { testSetupCtx } from "@gent/core/test-utils"
import { reducerActor } from "./helpers/reducer-actor"

describe("extension api", () => {
  test("setup exposes declared tools, prompt sections, and agents", async () => {
    const ext = extension("test-simple", ({ ext }) =>
      ext
        .tools({
          name: "greet",
          description: "Say hello",
          parameters: { name: { type: "string" } },
          execute: async (params) => `Hello, ${params.name}!`,
        })
        .promptSections({ id: "custom-rules", content: "Be nice.", priority: 50 })
        .agents({
          name: "helper",
          model: "test/model",
          description: "A helper agent",
        }),
    )

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    expect(setup.tools?.map((tool) => tool.name)).toEqual(["greet"])
    expect(setup.promptSections?.map((section) => section.id)).toEqual(["custom-rules"])
    expect(setup.agents?.map((agent) => agent.name)).toEqual(["helper"])
  })

  test("factory receives setup context and can be async", async () => {
    let receivedCwd = ""
    let receivedSource = ""
    const ext = extension("ctx-test", async ({ ext, ctx }) => {
      await Promise.resolve()
      receivedCwd = ctx.cwd
      receivedSource = ctx.source
      return ext
    })

    await Effect.runPromise(
      ext.setup(testSetupCtx({ cwd: "/my/project", source: "/path/to/ext.ts" })),
    )
    expect(receivedCwd).toBe("/my/project")
    expect(receivedSource).toBe("/path/to/ext.ts")
  })

  test("factory error maps to setup failure", async () => {
    const ext = extension("fail-factory", () => {
      throw new Error("factory broke")
    })

    const exit = await Effect.runPromiseExit(ext.setup(testSetupCtx()))
    expect(exit._tag).toBe("Failure")
  })

  test("interceptors register through the extension setup", async () => {
    const ext = extension("hook-test", ({ ext }) =>
      ext
        .on("prompt.system", async (input, next) => {
          const result = await next(input)
          return `${result}\n-- Added by extension`
        })
        .on("turn.after", async () => {}),
    )

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    expect(setup.hooks?.interceptors?.map((interceptor) => interceptor.key)).toEqual([
      "prompt.system",
      "turn.after",
    ])
  })

  test("startup and shutdown hooks compose in registration order", async () => {
    const order: string[] = []
    const ext = extension("lifecycle-test", ({ ext }) =>
      ext
        .onStartup(() => {
          order.push("startup:sync")
        })
        .onStartupEffect(Effect.sync(() => order.push("startup:effect")))
        .onShutdown(() => {
          order.push("shutdown")
        }),
    )

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    await Effect.runPromise(setup.onStartup!)
    await Effect.runPromise(setup.onShutdown!)
    expect(order).toEqual(["startup:sync", "startup:effect", "shutdown"])
  })

  test("integrates with extension registry", async () => {
    const ext = extension("registry-test", ({ ext }) =>
      ext
        .tools({
          name: "my_tool",
          description: "test tool",
          execute: async () => "ok",
        })
        .promptSections({ id: "test-section", content: "test content", priority: 90 }),
    )

    const loaded = {
      manifest: ext.manifest,
      kind: "user" as const,
      sourcePath: "test",
      setup: await Effect.runPromise(ext.setup(testSetupCtx())),
    }

    const resolved = resolveExtensions([loaded])
    const layer = ExtensionRegistry.fromResolved(resolved)

    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const tools = yield* registry.listTools()
        expect(tools.some((tool) => tool.name === "my_tool")).toBe(true)

        const sections = yield* registry.listPromptSections()
        expect(sections.some((section) => section.id === "test-section")).toBe(true)
      }).pipe(Effect.provide(layer)),
    )
  })

  test("ext.command() stores commands discoverable via listCommands", async () => {
    const ext = extension("cmd-test", ({ ext }) =>
      ext
        .command("deploy", {
          description: "Deploy the app",
          handler: async (_args, _ctx) => {},
        })
        .command("rollback", { handler: async () => {} }),
    )

    const loaded = {
      manifest: ext.manifest,
      kind: "user" as const,
      sourcePath: "test",
      setup: await Effect.runPromise(ext.setup(testSetupCtx())),
    }

    const resolved = resolveExtensions([loaded])
    const layer = ExtensionRegistry.fromResolved(resolved)

    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const cmds = yield* registry.listCommands()
        expect(cmds).toHaveLength(2)
        expect(cmds[0]?.name).toBe("deploy")
        expect(cmds[0]?.description).toBe("Deploy the app")
        expect(cmds[1]?.name).toBe("rollback")
        expect(cmds[1]?.description).toBeUndefined()
      }).pipe(Effect.provide(layer)),
    )
  })

  test("ext.on() handlers receive ExtensionHostContext", async () => {
    let receivedCtx: unknown = undefined
    const ext = extension("ctx-forward-test", ({ ext }) =>
      ext.on("turn.after", (input, next, ctx) =>
        Effect.gen(function* () {
          yield* next(input)
          receivedCtx = ctx
        }),
      ),
    )

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    const loaded = {
      manifest: ext.manifest,
      kind: "user" as const,
      sourcePath: "test",
      setup,
    }

    const resolved = resolveExtensions([loaded])
    const { compileHooks } = await import("@gent/core/runtime/extensions/hooks")
    const compiled = compileHooks(resolved.extensions)
    const stubCtx = {
      sessionId: SessionId.of("s"),
      branchId: BranchId.of("b"),
      cwd: "/tmp",
      home: "/tmp",
    } as ExtensionHostContext

    await Effect.runPromise(
      compiled.runInterceptor(
        "turn.after",
        {
          sessionId: SessionId.of("s"),
          branchId: BranchId.of("b"),
          durationMs: 0,
          agentName: "cowork" as never,
          interrupted: false,
        },
        () => Effect.void,
        stubCtx,
      ),
    )

    expect(receivedCtx).toBeDefined()
    expect((receivedCtx as { sessionId: string }).sessionId).toBe("s")
  })

  test("ext.exec() runs shell commands", async () => {
    const ext = extension("exec-test", ({ ext }) =>
      ext.onStartup(async () => {
        const result = await ext.exec("echo", ["hello"])
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe("hello")
        expect(result.stderr).toBe("")
      }),
    )

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    await Effect.runPromise(setup.onStartup!)
  })
  test("ext.exec() returns timedOut on timeout", async () => {
    let result: { exitCode: number; timedOut?: boolean } | undefined
    const ext = extension("exec-timeout-test", ({ ext }) =>
      ext.onStartup(async () => {
        result = await ext.exec("sleep", ["10"], { timeout: 1 })
      }),
    )

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    await Effect.runPromise(setup.onStartup!)

    expect(result).toBeDefined()
    expect(result!.timedOut).toBe(true)
  })

  test("ext.async.on() handlers receive ExtensionContext with Promise methods", async () => {
    let receivedCtx: unknown = undefined
    const ext = extension("async-ctx-test", ({ ext }) => {
      ext.async.on("turn.after", async (input, next, ctx) => {
        await next(input)
        receivedCtx = ctx
      })
      return ext
    })

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    const loaded = {
      manifest: ext.manifest,
      kind: "user" as const,
      sourcePath: "test",
      setup,
    }

    const resolved = resolveExtensions([loaded])
    const { compileHooks } = await import("@gent/core/runtime/extensions/hooks")
    const compiled = compileHooks(resolved.extensions)
    const stubCtx = {
      sessionId: SessionId.of("async-s"),
      branchId: BranchId.of("async-b"),
      cwd: "/tmp",
      home: "/tmp",
      session: {
        listMessages: () => Effect.succeed([]),
      },
    } as ExtensionHostContext

    await Effect.runPromise(
      compiled.runInterceptor(
        "turn.after",
        {
          sessionId: SessionId.of("async-s"),
          branchId: BranchId.of("async-b"),
          durationMs: 42,
          agentName: "cowork" as never,
          interrupted: false,
        },
        () => Effect.void,
        stubCtx,
      ),
    )

    expect(receivedCtx).toBeDefined()
    // ExtensionContext has Promise-returning methods, not Effect
    const ctx = receivedCtx as { sessionId: string; session: { listMessages: () => unknown } }
    expect(ctx.sessionId).toBe("async-s")
    const result = ctx.session.listMessages()
    expect(result).toBeInstanceOf(Promise)
  })

  test("ext.async.on() turn.after handler can skip next", async () => {
    let nextCalled = false
    const ext = extension("async-skip-test", ({ ext }) => {
      ext.async.on("turn.after", async (_input, _next) => {
        // intentionally not calling next
      })
      return ext
    })

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    const resolved = resolveExtensions([
      { manifest: ext.manifest, kind: "user" as const, sourcePath: "test", setup },
    ])
    const { compileHooks } = await import("@gent/core/runtime/extensions/hooks")
    const compiled = compileHooks(resolved.extensions)
    const stubCtx = {
      sessionId: SessionId.of("s"),
      branchId: BranchId.of("b"),
      cwd: "/tmp",
      home: "/tmp",
    } as ExtensionHostContext

    await Effect.runPromise(
      compiled.runInterceptor(
        "turn.after",
        {
          sessionId: SessionId.of("s"),
          branchId: BranchId.of("b"),
          durationMs: 0,
          agentName: "cowork" as never,
          interrupted: false,
        },
        () => {
          nextCalled = true
          return Effect.void
        },
        stubCtx,
      ),
    )

    expect(nextCalled).toBe(false)
  })

  test("ext.on('turn.before') registers and fires via Effect-native path", async () => {
    const captured: unknown[] = []
    const ext = extension("turn-before-effect-test", ({ ext }) =>
      ext.on("turn.before", (input, next) => {
        captured.push(input)
        return next(input)
      }),
    )

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    const resolved = resolveExtensions([
      { manifest: ext.manifest, kind: "user" as const, sourcePath: "test", setup },
    ])
    const { compileHooks } = await import("@gent/core/runtime/extensions/hooks")
    const compiled = compileHooks(resolved.extensions)
    const stubCtx = {
      sessionId: SessionId.of("s"),
      branchId: BranchId.of("b"),
      cwd: "/tmp",
      home: "/tmp",
    } as ExtensionHostContext

    await Effect.runPromise(
      compiled.runInterceptor(
        "turn.before",
        {
          sessionId: SessionId.of("s"),
          branchId: BranchId.of("b"),
          agentName: "cowork" as never,
          toolCount: 3,
          systemPromptLength: 500,
        },
        () => Effect.void,
        stubCtx,
      ),
    )

    expect(captured).toHaveLength(1)
    expect((captured[0] as { toolCount: number }).toolCount).toBe(3)
  })

  test("ext.async.on('turn.before') registers and fires via async path", async () => {
    const captured: unknown[] = []
    const ext = extension("turn-before-async-test", ({ ext }) => {
      ext.async.on("turn.before", async (input, next) => {
        captured.push(input)
        await next(input)
      })
      return ext
    })

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    const resolved = resolveExtensions([
      { manifest: ext.manifest, kind: "user" as const, sourcePath: "test", setup },
    ])
    const { compileHooks } = await import("@gent/core/runtime/extensions/hooks")
    const compiled = compileHooks(resolved.extensions)
    const stubCtx = {
      sessionId: SessionId.of("s"),
      branchId: BranchId.of("b"),
      cwd: "/tmp",
      home: "/tmp",
    } as ExtensionHostContext

    await Effect.runPromise(
      compiled.runInterceptor(
        "turn.before",
        {
          sessionId: SessionId.of("s"),
          branchId: BranchId.of("b"),
          agentName: "cowork" as never,
          toolCount: 7,
          systemPromptLength: 1000,
        },
        () => Effect.void,
        stubCtx,
      ),
    )

    expect(captured).toHaveLength(1)
    expect((captured[0] as { systemPromptLength: number }).systemPromptLength).toBe(1000)
  })

  test("message.input interceptor transforms user input", async () => {
    const ext = extension("input-transform-test", ({ ext }) =>
      ext.on("message.input", (input, next) =>
        next({ ...input, content: input.content.toUpperCase() }),
      ),
    )

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    const resolved = resolveExtensions([
      { manifest: ext.manifest, kind: "user" as const, sourcePath: "test", setup },
    ])
    const { compileHooks } = await import("@gent/core/runtime/extensions/hooks")
    const compiled = compileHooks(resolved.extensions)
    const stubCtx = {
      sessionId: SessionId.of("s"),
      branchId: BranchId.of("b"),
      cwd: "/tmp",
      home: "/tmp",
    } as ExtensionHostContext

    const result = await Effect.runPromise(
      compiled.runInterceptor(
        "message.input",
        { content: "hello world", sessionId: SessionId.of("s"), branchId: BranchId.of("b") },
        (i) => Effect.succeed(i.content),
        stubCtx,
      ),
    )

    expect(result).toBe("HELLO WORLD")
  })

  test("message.input chain composes multiple interceptors", async () => {
    const ext1 = extension("input-chain-1", ({ ext }) =>
      ext.on("message.input", (input, next) =>
        next({ ...input, content: input.content + " [ext1]" }),
      ),
    )
    const ext2 = extension("input-chain-2", ({ ext }) =>
      ext.on("message.input", (input, next) =>
        next({ ...input, content: input.content + " [ext2]" }),
      ),
    )

    const setup1 = await Effect.runPromise(ext1.setup(testSetupCtx()))
    const setup2 = await Effect.runPromise(ext2.setup(testSetupCtx()))
    const resolved = resolveExtensions([
      { manifest: ext1.manifest, kind: "user" as const, sourcePath: "test", setup: setup1 },
      { manifest: ext2.manifest, kind: "user" as const, sourcePath: "test", setup: setup2 },
    ])
    const { compileHooks } = await import("@gent/core/runtime/extensions/hooks")
    const compiled = compileHooks(resolved.extensions)
    const stubCtx = {
      sessionId: SessionId.of("s"),
      branchId: BranchId.of("b"),
      cwd: "/tmp",
      home: "/tmp",
    } as ExtensionHostContext

    const result = await Effect.runPromise(
      compiled.runInterceptor(
        "message.input",
        { content: "base", sessionId: SessionId.of("s"), branchId: BranchId.of("b") },
        (i) => Effect.succeed(i.content),
        stubCtx,
      ),
    )

    // Interceptors compose: ext1 runs inside ext2's next chain
    expect(result).toContain("[ext1]")
    expect(result).toContain("[ext2]")
  })
})

describe("extension tools through ToolRunner.run", () => {
  const ext = extension("runner-test", ({ ext }) =>
    ext.tools({
      name: "format",
      description: "Formats a greeting",
      parameters: {
        name: { type: "string" },
        count: { type: "number", optional: true },
      },
      execute: async (params) => {
        const count = (params.count as number | undefined) ?? 1
        return `Hello, ${params.name}! (x${String(count)})`
      },
    }),
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layer: Layer.Layer<any>

  beforeAll(async () => {
    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    const baseDeps = Layer.mergeAll(
      ExtensionRegistry.fromResolved(
        resolveExtensions([{ manifest: ext.manifest, kind: "user", sourcePath: "test", setup }]),
      ),
      Permission.Test(),
      ApprovalService.Test(),
      RuntimePlatform.Test({ cwd: "/tmp", home: "/tmp", platform: "test" }),
      ExtensionStateRuntime.Test(),
    )
    const runnerLayer = ToolRunner.Live.pipe(Layer.provide(baseDeps))
    layer = Layer.mergeAll(baseDeps, runnerLayer)
  })

  const ctx = {
    sessionId: SessionId.of("s1"),
    branchId: BranchId.of("b1"),
    toolCallId: ToolCallId.of("tc1"),
  }

  test("runs tool with required and optional params", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc1", toolName: "format", input: { name: "Ada", count: 3 } },
          ctx,
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(result.output.type).toBe("json")
    expect(result.output.value).toBe("Hello, Ada! (x3)")
  })

  test("returns validation errors for malformed input", async () => {
    const missingParam = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run({ toolCallId: "tc2", toolName: "format", input: {} }, ctx)
      }).pipe(Effect.provide(layer)),
    )

    const wrongType = await Effect.runPromise(
      Effect.gen(function* () {
        const runner = yield* ToolRunner
        return yield* runner.run(
          { toolCallId: "tc3", toolName: "format", input: { name: 42 } },
          ctx,
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(missingParam.output.type).toBe("error-json")
    expect(wrongType.output.type).toBe("error-json")
  })
})

describe("state-backed extension api", () => {
  test("stateful actor extensions expose the actor surface only", async () => {
    const ext = extension("state-agent-run-alias", ({ ext }) =>
      ext.actor(
        reducerActor({
          initial: { seenType: false, seenTag: false, seenRawTag: false },
          stateSchema: Schema.Struct({
            seenType: Schema.Boolean,
            seenTag: Schema.Boolean,
            seenRawTag: Schema.Boolean,
          }),
          id: "state-agent-run-alias",
          reduce: (state, event) => {
            if (event._tag === "AgentRunSpawned") {
              return {
                state: {
                  seenType: true,
                  seenTag: event._tag === "AgentRunSpawned",
                  seenRawTag: true,
                },
              }
            }
            return { state }
          },
          derive: (state) => ({
            promptSections: state.seenType
              ? [{ id: "seen", content: "seen", priority: 50 }]
              : undefined,
          }),
        }),
      ),
    )

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    expect(setup.actor).toBeDefined()
    const actorLayer = ExtensionTurnControl.Test()
    const actor = await Effect.runPromise(
      spawnMachineExtensionRef("state-agent-run-alias", setup.actor!, {
        sessionId: SessionId.of("s1"),
        branchId: BranchId.of("b1"),
      }).pipe(Effect.provide(actorLayer)),
    )

    await Effect.runPromise(actor.start.pipe(Effect.provide(actorLayer)))
    await Effect.runPromise(
      actor
        .publish(
          new AgentRunSpawned({
            parentSessionId: SessionId.of("s1"),
            childSessionId: SessionId.of("s2"),
            agentName: "reviewer",
            prompt: "inspect",
            branchId: BranchId.of("b1"),
          }),
          { sessionId: SessionId.of("s1"), branchId: BranchId.of("b1") },
        )
        .pipe(Effect.provide(actorLayer)),
    )

    const snapshot = await Effect.runPromise(actor.snapshot.pipe(Effect.provide(actorLayer)))
    expect(snapshot.state).toEqual({
      _tag: "Active",
      value: { seenType: true, seenTag: true, seenRawTag: true },
    })
    await Effect.runPromise(actor.stop.pipe(Effect.provide(actorLayer)))
  })

  test("jobs register through the minimal surface", async () => {
    const ext = extension("jobs-test", ({ ext }) =>
      ext.jobs({
        id: "reflect",
        schedule: "0 9 * * *",
        target: {
          kind: "headless-agent",
          agent: "explore",
          prompt: "hello",
        },
      }),
    )

    const setup = await Effect.runPromise(ext.setup(testSetupCtx()))
    expect(setup.jobs?.map((job) => job.id)).toEqual(["reflect"])
  })
})
