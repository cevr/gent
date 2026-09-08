import { expect, it } from "effect-bun-test"
import { Effect, Fiber, FileSystem, Schema, Stream } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { makeTempDirectoryScoped } from "@gent/core-internal/test-utils/fixtures"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { shippedPreset } from "../helpers/test-preset.js"

it.scopedLive(
  "reports unsupported downloads and failed npm commands as errors through a cell",
  () =>
    Effect.gen(function* () {
      const directory = yield* makeTempDirectoryScoped("gent-repo-tool-")
      const resultPath = `${directory}/results.json`
      const encodedPath = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
        resultPath,
      )
      const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
        toolCallStep("cell", {
          code: `var results = []; for (var spec of ["pypi:gent-e2e-missing", "crates:gent-e2e-missing", "npm:gent-e2e-missing@invalid version"]) { try { await tools.call("repo", {action:"fetch", spec}); results.push({spec, failed:false}); } catch (error) { results.push({spec, failed:true}); } } await Bun.write(${encodedPath}, JSON.stringify(results));`,
        }),
        textStep("done"),
      ])
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...shippedPreset,
        providerLayer,
      })
      const completed = yield* client.session.events({ sessionId, branchId }).pipe(
        Stream.filter(({ event }) => event._tag === "TurnCompleted"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* client.message.send({ sessionId, branchId, content: "Check repository errors" })
      yield* Fiber.join(completed)
      const fs = yield* FileSystem.FileSystem
      const results = yield* fs
        .readFileString(resultPath)
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Array(Schema.Struct({ spec: Schema.String, failed: Schema.Boolean })),
              ),
            ),
          ),
        )
      expect(results).toEqual([
        { spec: "pypi:gent-e2e-missing", failed: true },
        { spec: "crates:gent-e2e-missing", failed: true },
        { spec: "npm:gent-e2e-missing@invalid version", failed: true },
      ])
    }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("8 seconds")),
  10_000,
)
