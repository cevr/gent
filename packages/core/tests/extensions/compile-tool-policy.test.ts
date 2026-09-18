import { describe, test, expect } from "bun:test"
import { it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import {
  AgentDefinition,
  AgentName,
  defineExtension,
  ExtensionHost,
  getToolId,
  tool,
  type ToolCapability,
} from "@gent/core/extensions/api"
import { compileToolPolicy } from "../../src/runtime/tools"
import { createRpcHarness } from "../../src/test-utils/index"
import {
  LanguageModelLayers,
  textStep,
  toolCallStep,
  waitFor,
} from "../../src/test-utils/language-model"
import { messageSingleText } from "../../src/domain/message"
import { BunGentPlatformLive } from "../../src/runtime/gent-platform-bun"

describe("compileToolPolicy", () => {
  const makeTool = (name: string): ToolCapability =>
    tool({
      id: name,
      description: name,
      params: Schema.Struct({}),
      output: Schema.Null,
      // oxlint-disable-next-line effect/noNullish -- Tool fixture intentionally exercises Schema.Null output.
      execute: () => Effect.succeed(null),
    })

  const makeInteractiveTool = (name: string): ToolCapability =>
    tool({
      id: name,
      description: name,
      params: Schema.Struct({}),
      output: Schema.Null,
      interactive: true,
      // oxlint-disable-next-line effect/noNullish -- Tool fixture intentionally exercises Schema.Null output.
      execute: () => Effect.succeed(null),
    })

  const allTools = [
    makeTool("read"),
    makeTool("grep"),
    makeTool("glob"),
    makeTool("write"),
    makeTool("edit"),
    makeTool("bash"),
    makeTool("delegate"),
    makeTool("ask_user"),
    makeTool("webfetch"),
    makeTool("websearch"),
    makeTool("lookup"),
  ]

  const names = (tools: ReadonlyArray<ToolCapability>) =>
    tools.map((t) => String(getToolId(t))).sort()

  test("model selection leaves admitted host tools available", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const result = compileToolPolicy(allTools, agent, {}, [{ toolPolicy: { modelSet: ["read"] } }])
    expect(names(result.tools)).toEqual(names(allTools))
    expect(names(result.modelTools)).toEqual(["read"])
    expect(result.modelTools[0]).toBe(allTools[0])
  })

  test("model selection cannot restore unknown, denied, or non-interactive tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork"), deniedTools: ["bash"] })
    const result = compileToolPolicy(
      [...allTools, makeInteractiveTool("question")],
      agent,
      { interactive: false },
      [{ toolPolicy: { modelSet: ["read", "read", "bash", "question", "missing"] } }],
    )
    expect(names(result.modelTools)).toEqual(["read"])
  })

  test("the last explicit model selection wins and an empty set advertises no tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const result = compileToolPolicy(allTools, agent, {}, [
      { toolPolicy: { modelSet: ["read"] } },
      { toolPolicy: { modelSet: [] } },
      { toolPolicy: { include: ["bash"] } },
    ])
    expect(result.modelTools).toEqual([])
    expect(names(result.tools)).toEqual(names(allTools))
  })

  test("a cell name has no special allowance without an extension policy", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork"), allowedTools: ["read"] })
    const tools = [makeTool("cell"), ...allTools]
    const direct = compileToolPolicy(tools, agent, {}, [])
    expect(names(direct.modelTools)).toEqual(["read"])
    const selected = compileToolPolicy(tools, agent, {}, [
      { toolPolicy: { include: ["cell"], modelSet: ["cell"] } },
    ])
    expect(names(selected.modelTools)).toEqual(["cell"])
    expect(names(selected.tools)).toEqual(["cell", "read"])
  })

  test("no allow-list → all tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const { tools } = compileToolPolicy(allTools, agent, {}, [])
    expect(names(tools)).toEqual(names(allTools))
  })

  test("allowedTools restricts to exact set", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("cowork"),
      allowedTools: ["bash", "read"],
    })
    const { tools } = compileToolPolicy(allTools, agent, {}, [])
    expect(names(tools)).toEqual(["bash", "read"])
  })

  test("allowedTools: [] means no tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork"), allowedTools: [] })
    const { tools } = compileToolPolicy(allTools, agent, {}, [])
    expect(tools).toEqual([])
  })

  test("extension projection exclude removes tools", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const projections = [{ toolPolicy: { exclude: ["bash", "write"] } }]
    const { tools } = compileToolPolicy(allTools, agent, {}, projections)
    expect(names(tools)).not.toContain("bash")
    expect(names(tools)).not.toContain("write")
  })

  test("extension projection include adds tools when they are allowed", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("cowork"),
      allowedTools: ["read", "grep", "lookup"],
    })
    const projections = [{ toolPolicy: { include: ["bash"] } }]
    const { tools } = compileToolPolicy(allTools, agent, {}, projections)
    expect(names(tools)).toContain("bash")
    expect(names(tools)).toContain("read")
  })

  test("extension projection overrideSet replaces tool list", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const projections = [{ toolPolicy: { overrideSet: ["read", "grep"] } }]
    const { tools } = compileToolPolicy(allTools, agent, {}, projections)
    expect(names(tools)).toEqual(["grep", "read"])
  })

  test("denied tools cannot be re-added by extension projection include", () => {
    const agent = AgentDefinition.make({
      name: AgentName.make("cowork"),
      deniedTools: ["bash"],
    })
    const projections = [{ toolPolicy: { include: ["bash"] } }]
    const { tools } = compileToolPolicy(allTools, agent, {}, projections)
    expect(names(tools)).not.toContain("bash")
  })

  test("extension prompt sections collected", () => {
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const projections = [
      { promptSections: [{ id: "ext-a", content: "Section A", priority: 90 }] },
      { promptSections: [{ id: "ext-b", content: "Section B", priority: 91 }] },
    ]
    const { promptSections } = compileToolPolicy(allTools, agent, {}, projections)
    expect(promptSections).toHaveLength(2)
    expect(promptSections.map((s) => s.id)).toEqual(["ext-a", "ext-b"])
  })

  test("interactive tools filtered when context.interactive is false", () => {
    const interactiveTool = makeInteractiveTool("ask_user")
    const nonInteractiveTool = makeTool("read")
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const { tools } = compileToolPolicy(
      [interactiveTool, nonInteractiveTool],
      agent,
      { interactive: false },
      [],
    )
    expect(names(tools)).toEqual(["read"])
    expect(names(tools)).not.toContain("ask_user")
  })

  test("interactive tools remain available when the run is interactive", () => {
    const interactiveTool = makeInteractiveTool("ask_user")
    const agent = AgentDefinition.make({ name: AgentName.make("cowork") })
    const { tools } = compileToolPolicy([interactiveTool], agent, {}, [])
    expect(names(tools)).toContain("ask_user")
  })
})

describe("extension model surface over RPC", () => {
  for (const selected of [false, true]) {
    let name = "advertises direct tools without a special case for the cell name"
    if (selected) name = "runs an extension-selected tool with exact admitted bindings"
    it.scopedLive(name, () =>
      Effect.gen(function* () {
        let observedHostTools: ReadonlyArray<string> = []
        const extension = defineExtension({
          id: "test/model-surface",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "agent",
              AgentDefinition.make({ name: AgentName.make("main"), deniedTools: ["blocked"] }),
            )
            for (const name of ["bridge", "cell", "blocked"]) {
              yield* host.register(
                "tool",
                tool({
                  id: name,
                  description: `Run ${name}`,
                  params: Schema.Struct({ value: Schema.String }),
                  output: Schema.String,
                  execute: ({ value }) => Effect.succeed(`${name}:${value}`),
                }),
              )
            }
            if (selected) {
              yield* host.on("turnProjection", () =>
                Effect.succeed({
                  toolPolicy: { modelSet: ["bridge", "blocked", "missing"] },
                }),
              )
            }
            yield* host.on("systemPrompt", (input) =>
              Effect.sync(() => {
                observedHostTools = input.hostTools?.map(getToolId).sort() ?? []
                return input.basePrompt
              }),
            )
          }),
        })
        const call = toolCallStep("bridge", { value: "kept" })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          {
            ...call,
            assertOptions: (options) => {
              let expected = ["bridge", "cell"]
              if (selected) expected = ["bridge"]
              expect(
                options.tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
              ).toEqual(expected)
            },
          },
          textStep("finished"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: [],
          extensionInputs: [extension],
          providerLayer,
        })
        yield* client.message.send({ sessionId, branchId, content: "Use the bridge." })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (messages) =>
            messages.some(
              (message) =>
                message.role === "assistant" && messageSingleText(message.parts) === "finished",
            ),
          3000,
          "bridge reply",
        )
        expect(
          messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool-result"),
        ).toMatchObject([{ name: "bridge", isFailure: false, result: "bridge:kept" }])
        expect(observedHostTools).toEqual(["bridge", "cell"])
        yield* controls.assertDone
      }).pipe(
        Effect.timeout("4 seconds"),
        Effect.provide(Layer.merge(BunServices.layer, BunGentPlatformLive)),
      ),
    )
  }
})
