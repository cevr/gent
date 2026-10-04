import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, FileSystem, Path, Schema, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import { ExtensionStatus } from "@gent/core/extensions/api"
import {
  createRpcHarness,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textStep,
  toolCallStep,
} from "@gent/core/test-utils"
import { AgentsExtension } from "../src/agents.js"
import { ExtensionAdminExtension } from "../src/extension-admin.js"

const StatusOutput = Schema.fromJsonString(
  Schema.Struct({ extensions: Schema.Array(ExtensionStatus) }),
)

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
