import { BunServices } from "@effect/platform-bun"
import { AgentName } from "@gent/core/extensions/api"
import {
  createRpcHarness,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  multiToolCallStep,
  textStep,
  waitFor,
} from "@gent/core/test-utils"
import { BuiltinExtensions } from "@gent/extensions"
import { Effect, FileSystem, Path } from "effect"
import { describe, expect, it } from "effect-bun-test"
import PainterExtension from "../extensions/painter.js"

/**
 * Acceptance for a project extension beside a shipped one: the test loads
 * the shipped file tools by their id with the painter example, and the
 * painter's file calls reach its `paths` and nothing else. A project's
 * `.gent/tests` resolves `@gent/extensions` the same way (docs/extensions.md,
 * Testing).
 */

const FsTools = BuiltinExtensions.filter((extension) => extension.manifest.id === "@gent/fs-tools")

describe("painter example extension", () => {
  const fsTest = it.scopedLive.layer(BunServices.layer)

  fsTest(
    "the painter's file tools reach its paths and nothing else",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const cwd = yield* makeTempDirectoryScoped("painter-cwd-")
        yield* fs.makeDirectory(path.join(cwd, "films"))
        yield* fs.makeDirectory(path.join(cwd, "notes"))
        yield* fs.writeFileString(path.join(cwd, "films", "scene.ts"), "scene")
        yield* fs.writeFileString(path.join(cwd, "notes", "cues.md"), "cue 1")
        yield* fs.writeFileString(path.join(cwd, "outside.txt"), "untouched")
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          multiToolCallStep(
            // Inside its paths: each succeeds.
            { toolName: "read", input: { path: "notes/cues.md" } },
            { toolName: "grep", input: { pattern: "cue", path: "notes" } },
            {
              toolName: "edit",
              input: { path: "films/scene.ts", oldString: "scene", newString: "scene 2" },
            },
            { toolName: "write", input: { path: "films/new.ts", content: "painted" } },
            // A write under a read entry, a read outside: each is refused.
            { toolName: "write", input: { path: "notes/cues.md", content: "x" } },
            { toolName: "read", input: { path: "outside.txt" } },
          ),
          textStep("done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: [],
          extensionInputs: [...FsTools, PainterExtension],
          providerLayer,
          cwd,
          admission: { agent: AgentName.make("painter") },
        })
        yield* client.message.send({ sessionId, branchId, content: "Paint the scene." })
        const messages = yield* waitFor(
          client.message.list({ branchId }),
          (list) =>
            list.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "done"),
            ),
          6000,
          "the reply after the file calls",
        )
        yield* controls.assertDone
        const failed = messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result")
          .map((part) => part.isFailure)
        expect(failed).toEqual([false, false, false, false, true, true])
        expect(yield* fs.readFileString(path.join(cwd, "films", "scene.ts"))).toBe("scene 2")
        expect(yield* fs.readFileString(path.join(cwd, "films", "new.ts"))).toBe("painted")
        expect(yield* fs.readFileString(path.join(cwd, "notes", "cues.md"))).toBe("cue 1")
      }).pipe(Effect.timeout("12 seconds")),
    15_000,
  )
})
