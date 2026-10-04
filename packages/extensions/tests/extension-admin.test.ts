import { describe, expect, it } from "effect-bun-test"
import { Clock, Effect, Fiber, FileSystem, Layer, Option, Path, Ref, Schema, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { ExtensionId, ExtensionStatus, resolveDataDir } from "@gent/core/extensions/api"
import { BunPlatformLive } from "@gent/core/host"
import { messagePartsText } from "@gent/core/protocol"
import {
  ApprovalService,
  ConfigService,
  createRpcHarness,
  RuntimeEnvironment,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textStep,
  toolCallStep,
} from "@gent/core/test-utils"
import { AgentsExtension } from "../src/agents.js"
import { ExtensionAdminExtension } from "../src/extension-admin.js"
import { bundledSkillFiles } from "../src/skills.js"

const StatusOutput = Schema.fromJsonString(
  Schema.Struct({ extensions: Schema.Array(ExtensionStatus) }),
)

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

/** What a pane request answers: what it did, and the statuses after it. */
const PaneOutput = Schema.Struct({
  detail: Schema.String,
  extensions: Schema.Array(ExtensionStatus),
})

const VerbOutput = Schema.fromJsonString(
  Schema.Struct({
    applied: Schema.Boolean,
    detail: Schema.String,
    resumeQueued: Schema.Boolean,
    extensions: Schema.Array(ExtensionStatus),
  }),
)

/** A user extension file whose one tool, `toolId`, reports `text`. */
const probeSource = (id: string, text: string, toolId = "probe.version") =>
  [
    'import { Effect, Schema } from "effect";',
    'import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api";',
    "export default defineExtension({",
    `  id: "${id}",`,
    "  setup: Effect.gen(function* () {",
    "    const host = yield* ExtensionHost;",
    '    yield* host.register("tool", tool({',
    `      id: "${toolId}",`,
    '      description: "Report the probe version",',
    "      params: Schema.Struct({}),",
    "      output: Schema.String,",
    `      execute: () => Effect.succeed("${text}"),`,
    "    }));",
    "  }),",
    "});",
    "",
  ].join("\n")

describe("extensions.status", () => {
  it.live(
    "an extension the agent writes while gent runs shows as failed, at the phase that stopped it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* makeTempDirectoryScoped("gent-extension-admin-home-")
        const extensionsDir = path.join(home, ".gent", "extensions")
        yield* fs.makeDirectory(extensionsDir, { recursive: true })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("extensions.status", {}),
          textStep("listed"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: [],
          extensionInputs: [AgentsExtension, ExtensionAdminExtension],
          providerLayer,
          home,
          // This test is about the failure report, so the turn must survive it.
          allowFailedExtensions: true,
        })
        // Written after the server started, as the agent writes one.
        yield* fs.writeFileString(
          path.join(extensionsDir, "draft.ts"),
          [
            'import { Effect } from "effect";',
            'import { defineExtension } from "@gent/core/extensions/api";',
            'export default defineExtension({ id: "@test/draft", setup: Effect.die("not yet") });',
            "",
          ].join("\n"),
        )
        const turn = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.takeUntil(({ event }) => event._tag === "TurnCompleted"),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "did my extension load?" })
        const events = Array.from(yield* Fiber.join(turn)).map(({ event }) => event)
        yield* controls.assertDone
        const succeeded = events.find((event) => event._tag === "ToolCallSucceeded")
        if (succeeded?._tag !== "ToolCallSucceeded") return expect.unreachable()
        const { extensions: statuses } = yield* Schema.decodeUnknownEffect(StatusOutput)(
          succeeded.output,
        )
        const byId = new Map(statuses.map((status) => [status.id, status]))
        expect(byId.get("@test/draft")).toMatchObject({ _tag: "Failed", phase: "setup" })
        expect(byId.get("@gent/extension-admin")).toMatchObject({ _tag: "Active" })
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
    15_000,
  )

  it.live(
    "an edit that breaks an extension keeps its last good tool running, and status and health say why",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* makeTempDirectoryScoped("gent-extension-admin-home-")
        const probe = path.join(home, ".gent", "extensions", "probe.ts")
        yield* fs.makeDirectory(path.dirname(probe), { recursive: true })
        yield* fs.writeFileString(
          probe,
          [
            'import { Effect, Schema } from "effect";',
            'import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api";',
            "export default defineExtension({",
            '  id: "@test/probe",',
            "  setup: Effect.gen(function* () {",
            "    const host = yield* ExtensionHost;",
            '    yield* host.register("tool", tool({',
            '      id: "probe.version",',
            '      description: "Report the probe version",',
            "      params: Schema.Struct({}),",
            "      output: Schema.String,",
            '      execute: () => Effect.succeed("first version"),',
            "    }));",
            "  }),",
            "});",
            "",
          ].join("\n"),
        )
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("probe.version", {}),
          textStep("first turn"),
          toolCallStep("extensions.status", { id: "@test/probe" }),
          toolCallStep("probe.version", {}),
          textStep("second turn"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: [],
          extensionInputs: [AgentsExtension, ExtensionAdminExtension],
          providerLayer,
          home,
          // This test is about a failed reload, so the turn must survive it.
          allowFailedExtensions: true,
        })
        // Each turn reads the events after the last one the turn before it read.
        const runTurn = (content: string, after: number) =>
          Effect.gen(function* () {
            const turn = yield* client.session.events({ sessionId, branchId, after }).pipe(
              Stream.takeUntil(({ event }) => event._tag === "TurnCompleted"),
              Stream.runCollect,
              Effect.forkScoped,
            )
            yield* client.message.send({ sessionId, branchId, content })
            return Array.from(yield* Fiber.join(turn))
          })
        const first = yield* runTurn("which version runs?", 0)

        // The agent's edit breaks the file.
        yield* fs.writeFileString(probe, "export default defineExtension({\n")
        const second = yield* runTurn("and now?", first.at(-1)?.id ?? 0)
        yield* controls.assertDone
        const outputs = second.flatMap(({ event }) => {
          if (event._tag !== "ToolCallSucceeded") return []
          return [event.output]
        })
        expect(outputs).toHaveLength(2)
        const [statusOutput = "", probeOutput = ""] = outputs
        const { extensions } = yield* Schema.decodeEffect(StatusOutput)(statusOutput)
        expect(extensions).toEqual([
          expect.objectContaining({
            _tag: "Active",
            id: "@test/probe",
            reloadFailed: expect.objectContaining({ phase: "load" }),
          }),
        ])
        expect(String(probeOutput)).toContain("first version")

        const health = yield* client.extension.listStatus({
          scope: { _tag: "Session", id: sessionId },
        })
        if (health._tag !== "Degraded") return expect.unreachable()
        const degraded = health.degradedExtensions.find(
          (entry) => entry.manifest.id === "@test/probe",
        )
        expect(degraded?.issues).toEqual([
          expect.objectContaining({
            _tag: "ActivationFailed",
            phase: "load",
            runningVersion: expect.any(String),
          }),
        ])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
    15_000,
  )
})

// ── verbs ───────────────────────────────────────────────────────────────────

/**
 * A server whose home holds the `@test/probe` user extension, with the live
 * approval service, so an ask waits for the answer a turn gives it.
 */
const adminServer = (params: {
  readonly steps: Parameters<typeof LanguageModelLayers.sequence>[0]
  readonly cwd?: string
  readonly userConfig?: string
  /** Only for a test about a config file the server reports failed. */
  readonly allowFailedExtensions?: boolean
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* makeTempDirectoryScoped("gent-extension-admin-home-")
    const extensionsDir = path.join(home, ".gent", "extensions")
    const userConfig = path.join(home, ".gent", "config.json")
    yield* fs.makeDirectory(extensionsDir, { recursive: true })
    yield* fs.writeFileString(
      path.join(extensionsDir, "probe.ts"),
      probeSource("@test/probe", "on"),
    )
    const initialConfig = Option.fromUndefinedOr(params.userConfig)
    if (Option.isSome(initialConfig)) yield* fs.writeFileString(userConfig, initialConfig.value)
    const cwd = yield* Option.match(Option.fromUndefinedOr(params.cwd), {
      onNone: () => makeTempDirectoryScoped("gent-extension-admin-cwd-"),
      onSome: Effect.succeed,
    })
    const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence(params.steps)
    const harness = yield* createRpcHarness({
      agents: [],
      extensionInputs: [AgentsExtension, ExtensionAdminExtension],
      providerLayer,
      home,
      cwd,
      allowFailedExtensions: params.allowFailedExtensions === true,
      approvalLayer: ApprovalService.Live,
      // The verbs write the config files; the server reads them as they are.
      configServiceLayer: ConfigService.Live.pipe(
        Layer.provide(RuntimeEnvironment.Live({ cwd, home })),
        Layer.provide(BunPlatformLive),
      ),
    })
    // The last event a run read: the next run reads from after it.
    const lastRead = yield* Ref.make(0)
    /**
     * Send one message, answer each ask with `approved`, and read the events
     * until `turns` turns complete.
     */
    const run = (content: string, approved: boolean, turns = 1) =>
      Effect.gen(function* () {
        const { client, sessionId, branchId } = harness
        let completed = 0
        const after = yield* Ref.get(lastRead)
        const events = yield* client.session.events({ sessionId, branchId, after }).pipe(
          Stream.tap(({ event }) => {
            if (event._tag !== "InteractionPresented") return Effect.void
            return client.interaction.respondInteraction({
              sessionId,
              branchId,
              requestId: event.requestId,
              approved,
            })
          }),
          Stream.takeUntil(({ event }) => {
            if (event._tag === "TurnCompleted") completed += 1
            return completed >= turns
          }),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content })
        const envelopes = Array.from(yield* Fiber.join(events))
        for (const envelope of envelopes) yield* Ref.set(lastRead, envelope.id)
        return envelopes.map(({ event }) => event)
      })
    return { ...harness, home, extensionsDir, userConfig, controls, run }
  })

type TurnEvents = Effect.Success<ReturnType<Effect.Success<ReturnType<typeof adminServer>>["run"]>>

const succeededOutputs = (events: TurnEvents) =>
  events.flatMap((event) => {
    if (event._tag !== "ToolCallSucceeded") return []
    return [event.output]
  })

const decodeVerb = (output: string) => Schema.decodeEffect(VerbOutput)(output)

/** The tool ids a model request offers; the wire name spells each `.` as `__`. */
const toolNames = (options: { readonly tools: ReadonlyArray<{ readonly name: string }> }) =>
  options.tools.map((tool) => tool.name.replaceAll("__", "."))

describe("extension admin verbs", () => {
  it.live("the extensions skill's template loads as a user extension and its tool runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const skill = new Map(bundledSkillFiles).get("extensions/SKILL.md") ?? ""
      const template = /```ts\n([\s\S]*?)```/.exec(skill)?.[1] ?? ""
      expect(template).toContain("defineExtension")
      const server = yield* adminServer({
        steps: [toolCallStep("greet.say", { name: "Ada" }), textStep("greeted")],
      })
      yield* fs.writeFileString(path.join(server.extensionsDir, "greet.ts"), template)
      const events = yield* server.run("greet Ada", true)
      yield* server.controls.assertDone
      expect(succeededOutputs(events).join("")).toContain("Hello, Ada")
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
  )

  it.live(
    "an approved disable writes the user config, and the next turn has no tool of that extension",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const server = yield* adminServer({
          userConfig: '{"trustedProjects":["/nowhere"]}\n',
          steps: [
            {
              ...toolCallStep("extensions.disable", { id: "@test/probe", scope: "user" }),
              assertOptions: (options) => expect(toolNames(options)).toContain("probe.version"),
            },
            textStep("disabled"),
            {
              ...textStep("gone"),
              assertOptions: (options) => expect(toolNames(options)).not.toContain("probe.version"),
            },
          ],
        })
        const first = yield* server.run("turn it off", true)
        const [disabled = ""] = succeededOutputs(first)
        const verb = yield* decodeVerb(disabled)
        expect(verb.applied).toBe(true)
        expect(verb.extensions).toContainEqual(
          expect.objectContaining({ _tag: "Disabled", id: "@test/probe" }),
        )
        // The other keys stay as the user wrote them.
        const written = yield* fs.readFileString(server.userConfig)
        expect(written).toContain('"trustedProjects":["/nowhere"]')
        expect(written).toContain('"disabledExtensions":["@test/probe"]')

        // The next turn's model is offered no tool of the disabled extension.
        yield* server.run("is it gone?", true)
        yield* server.controls.assertDone
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("14 seconds")),
    16_000,
  )

  it.live("a declined disable writes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const before = '{"trustedProjects":[]}\n'
      const server = yield* adminServer({
        userConfig: before,
        steps: [
          toolCallStep("extensions.disable", { id: "@test/probe", scope: "user" }),
          textStep("declined"),
        ],
      })
      const events = yield* server.run("turn it off", false)
      yield* server.controls.assertDone
      expect(events.some((event) => event._tag === "InteractionPresented")).toBe(true)
      const [output = ""] = succeededOutputs(events)
      const verb = yield* decodeVerb(output)
      expect(verb).toMatchObject({ applied: false, detail: expect.stringContaining("declined") })
      expect(yield* fs.readFileString(server.userConfig)).toBe(before)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
  )

  it.live("a config file gent cannot decode is refused before any ask, and left as it is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // JSON, but `providers` is a record: the runtime rejects this file.
      const before = '{"providers":[]}\n'
      const server = yield* adminServer({
        userConfig: before,
        allowFailedExtensions: true,
        steps: [
          toolCallStep("extensions.disable", { id: "@test/probe", scope: "user" }),
          textStep("refused"),
        ],
      })
      const events = yield* server.run("turn it off", true)
      yield* server.controls.assertDone
      expect(events.some((event) => event._tag === "InteractionPresented")).toBe(false)
      const failed = events.find((event) => event._tag === "ToolCallFailed")
      if (failed?._tag !== "ToolCallFailed") return expect.unreachable()
      expect([failed.summary, failed.output].join(" ")).toContain("does not decode")
      expect(yield* fs.readFileString(server.userConfig)).toBe(before)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
  )

  it.live("a project the user does not trust is refused before any ask", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const project = yield* makeTempDirectoryScoped("gent-extension-admin-project-")
      const server = yield* adminServer({
        cwd: project,
        steps: [
          toolCallStep("extensions.disable", { id: "@test/probe", scope: "project" }),
          textStep("refused"),
        ],
      })
      const events = yield* server.run("turn it off here", true)
      yield* server.controls.assertDone
      expect(events.some((event) => event._tag === "InteractionPresented")).toBe(false)
      const failed = events.find((event) => event._tag === "ToolCallFailed")
      if (failed?._tag !== "ToolCallFailed") return expect.unreachable()
      expect([failed.summary, failed.output].join(" ")).toContain("not trusted")
      expect(yield* fs.exists(path.join(project, ".gent", "config.json"))).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("12 seconds")),
  )

  it.live("resume queues one turn that runs on the changed extensions", () =>
    Effect.gen(function* () {
      const server = yield* adminServer({
        steps: [
          toolCallStep("extensions.disable", {
            id: "@test/probe",
            scope: "user",
            resume: "Check the probe is gone.",
          }),
          textStep("disabled"),
          // The queued turn runs on the profile the change made.
          {
            ...textStep("it is gone"),
            assertOptions: (options) => expect(toolNames(options)).not.toContain("probe.version"),
          },
        ],
      })
      const events = yield* server.run("turn it off and go on", true, 2)
      yield* server.controls.assertDone
      const [output = ""] = succeededOutputs(events)
      expect((yield* decodeVerb(output)).resumeQueued).toBe(true)
      const opened = events.flatMap((event) => {
        if (event._tag !== "MessageReceived" || event.message.role !== "user") return []
        return [messagePartsText(event.message.parts)]
      })
      expect(opened).toHaveLength(2)
      expect(opened[1]).toContain("Check the probe is gone.")
      expect(events.filter((event) => event._tag === "TurnCompleted")).toHaveLength(2)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("14 seconds")),
  )

  it.live(
    "an approved add copies the extension in, and an approved remove moves it to the trash",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const project = yield* makeTempDirectoryScoped("gent-extension-admin-project-")
        yield* fs.writeFileString(
          path.join(project, "draft.ts"),
          probeSource("@test/draft", "draft", "draft.version"),
        )
        const server = yield* adminServer({
          cwd: project,
          steps: [
            toolCallStep("extensions.add", { path: "draft.ts", scope: "user" }),
            toolCallStep("extensions.remove", { id: "@test/draft" }),
            textStep("added and removed"),
          ],
        })
        const events = yield* server.run("add my draft, then take it out", true)
        yield* server.controls.assertDone
        const [addOutput = "", removeOutput = ""] = succeededOutputs(events)
        const added = yield* decodeVerb(addOutput)
        expect(added.applied).toBe(true)
        expect(added.extensions).toContainEqual(
          expect.objectContaining({ _tag: "Active", id: "@test/draft", scope: "user" }),
        )
        const removed = yield* decodeVerb(removeOutput)
        expect(removed.applied).toBe(true)
        expect(removed.extensions.map((status) => status.id)).not.toContain("@test/draft")
        expect(yield* fs.exists(path.join(server.extensionsDir, "draft.ts"))).toBe(false)
        const moved = /to (\S+extension-trash\S+): the/.exec(removed.detail)?.[1] ?? ""
        expect(yield* fs.readFileString(moved)).toContain("@test/draft")
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("14 seconds")),
  )

  // Two removes of one file name can land in one millisecond (two projects,
  // two sessions). The trash keeps each: none replaces another.
  it.live(
    "a remove never replaces an extension of the same name already in the trash",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const server = yield* adminServer({
          steps: [toolCallStep("extensions.remove", { id: "@test/probe" }), textStep("removed")],
        })
        // An earlier `probe.ts` in the trash under every name a remove in the
        // next seconds could take.
        const trash = path.join(yield* resolveDataDir(server.home), "extension-trash")
        yield* fs.makeDirectory(trash, { recursive: true })
        const now = yield* Clock.currentTimeMillis
        const earlier = Array.from({ length: 8000 }, (_, offset) => ({
          file: path.join(trash, `${String(now + offset)}-probe.ts`),
          text: `earlier ${String(offset)}`,
        }))
        yield* Effect.forEach(earlier, ({ file, text }) => fs.writeFileString(file, text), {
          concurrency: 64,
          discard: true,
        })
        const events = yield* server.run("remove the probe", true)
        yield* server.controls.assertDone
        const [output = ""] = succeededOutputs(events)
        const removed = yield* decodeVerb(output)
        expect(removed.applied).toBe(true)
        const moved = /to (\S+extension-trash\S+): the/.exec(removed.detail)?.[1] ?? ""
        expect(yield* fs.readFileString(moved)).toContain("@test/probe")
        const kept = yield* Effect.forEach(
          earlier,
          ({ file, text }) =>
            fs.readFileString(file).pipe(Effect.map((content) => content === text)),
          { concurrency: 64 },
        )
        expect(kept.every(Boolean)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
    25_000,
  )
})

// ── pane requests ───────────────────────────────────────────────────────────

describe("extension admin pane requests", () => {
  /** One pane request on the harness session, as the `/extensions` pane sends it. */
  const paneRequest = (
    server: Effect.Success<ReturnType<typeof adminServer>>,
    capabilityId: string,
    input: Readonly<Record<string, string | boolean>>,
  ) =>
    server.client.extension
      .request({
        sessionId: server.sessionId,
        branchId: server.branchId,
        extensionId: ExtensionId.make("@gent/extension-admin"),
        capabilityId,
        input,
      })
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PaneOutput)))
  const disabledIn = (configPath: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const text = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => "{}"))
      const config = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({ disabledExtensions: Schema.optional(Schema.Array(Schema.String)) }),
        ),
      )(text)
      return config.disabledExtensions ?? []
    })

  it.live("the pane turns an extension off and on without an ask, and the next turn follows", () =>
    Effect.gen(function* () {
      const server = yield* adminServer({
        steps: [
          {
            ...textStep("off"),
            assertOptions: (options) => expect(toolNames(options)).not.toContain("probe.version"),
          },
          {
            ...textStep("on"),
            assertOptions: (options) => expect(toolNames(options)).toContain("probe.version"),
          },
        ],
      })
      // The live approval service waits for an answer: an ask would never return.
      const off = yield* paneRequest(server, "extensions.pane.set-enabled", {
        id: "@test/probe",
        enabled: false,
      })
      expect(off.extensions).toContainEqual(
        expect.objectContaining({ _tag: "Disabled", id: "@test/probe" }),
      )
      expect(yield* disabledIn(server.userConfig)).toEqual(["@test/probe"])
      const offTurn = yield* server.run("is it off?", false)
      expect(offTurn.some((event) => event._tag === "InteractionPresented")).toBe(false)

      const on = yield* paneRequest(server, "extensions.pane.set-enabled", {
        id: "@test/probe",
        enabled: true,
      })
      expect(on.extensions).toContainEqual(
        expect.objectContaining({ _tag: "Active", id: "@test/probe" }),
      )
      expect(yield* disabledIn(server.userConfig)).toEqual([])
      yield* server.run("is it on?", false)
      yield* server.controls.assertDone
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("14 seconds")),
  )

  it.live(
    "in a trusted project the pane turns off in the project config, and turns on in every config that names it",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const project = yield* makeTempDirectoryScoped("gent-extension-admin-project-")
        const server = yield* adminServer({
          cwd: project,
          userConfig: `${encodeJson({ trustedProjects: [project], disabledExtensions: ["@test/other"] })}\n`,
          steps: [],
        })
        const projectConfig = path.join(project, ".gent", "config.json")
        yield* paneRequest(server, "extensions.pane.set-enabled", {
          id: "@test/probe",
          enabled: false,
        })
        expect(yield* disabledIn(projectConfig)).toEqual(["@test/probe"])
        expect(yield* disabledIn(server.userConfig)).toEqual(["@test/other"])

        const on = yield* paneRequest(server, "extensions.pane.set-enabled", {
          id: "@test/other",
          enabled: true,
        })
        expect(on.detail).toContain(server.userConfig)
        expect(yield* disabledIn(server.userConfig)).toEqual([])
        expect(yield* disabledIn(projectConfig)).toEqual(["@test/probe"])
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("14 seconds")),
  )

  it.live("the pane reads the session's statuses, and a change pulses the extension's state", () =>
    Effect.gen(function* () {
      const server = yield* adminServer({ steps: [] })
      const { client, sessionId, branchId } = server
      const pulse = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.filter(
          ({ event }) =>
            event._tag === "ExtensionStateChanged" && event.extensionId === "@gent/extension-admin",
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      )
      const status = yield* paneRequest(server, "extensions.pane.status", {})
      expect(status.detail).toBe("")
      expect(status.extensions).toContainEqual(
        expect.objectContaining({ _tag: "Active", id: "@test/probe" }),
      )
      yield* paneRequest(server, "extensions.pane.set-enabled", {
        id: "@test/probe",
        enabled: false,
      })
      expect(Array.from(yield* Fiber.join(pulse))).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("14 seconds")),
  )

  it.live("the pane refuses an id the session does not have, and reloads one it has", () =>
    Effect.gen(function* () {
      const server = yield* adminServer({ steps: [] })
      const refused = yield* paneRequest(server, "extensions.pane.set-enabled", {
        id: "@test/missing",
        enabled: false,
      }).pipe(Effect.flip)
      expect(String(refused.message)).toContain("@test/missing")
      expect(yield* disabledIn(server.userConfig)).toEqual([])

      const reloaded = yield* paneRequest(server, "extensions.pane.reload", { id: "@test/probe" })
      expect(reloaded.detail).toContain("@test/probe")
      expect(reloaded.extensions).toContainEqual(
        expect.objectContaining({ _tag: "Active", id: "@test/probe" }),
      )
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.timeout("14 seconds")),
  )
})
