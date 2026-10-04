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
})
