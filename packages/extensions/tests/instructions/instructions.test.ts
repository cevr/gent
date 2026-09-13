/**
 * Project instructions are read from `AGENTS.md` (or `CLAUDE.md`) files on
 * every turn and land in the system prompt as the project-instructions section.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Stream } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  finishPart,
  LanguageModelLayers,
  textDeltaPart,
} from "@gent/core-internal/test-utils/language-model.js"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness.js"
import { makeTempDirectoryScoped, waitFor } from "@gent/core-internal/test-utils/fixtures.js"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness.js"
import {
  projectInstructionsSection,
  readProjectInstructions,
} from "../../src/instructions/index.js"
import { e2ePreset } from "../helpers/test-preset.js"

const systemText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .filter((message): message is Prompt.SystemMessage => message.role === "system")
    .map((message) => message.content)
    .join("\n")

const writeFile = (path: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    yield* fs.writeFileString(path, content)
  })

describe("project instructions", () => {
  it.scopedLive("joins home, project and project-local files in prompt order", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const cwd = yield* makeTempDirectoryScoped("instructions-cwd-")
      yield* writeFile(`${home}/.gent/AGENTS.md`, "home rules\n")
      yield* writeFile(`${cwd}/CLAUDE.md`, "project rules")
      yield* writeFile(`${cwd}/.gent/AGENTS.md`, "local rules")
      const files = testToolContext({ home, cwd }).Files
      expect(yield* readProjectInstructions(files, { cwd, home })).toBe(
        "home rules\n---\nproject rules\n---\nlocal rules",
      )
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  it.scopedLive("an empty AGENTS.md defers to CLAUDE.md beside it", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const cwd = yield* makeTempDirectoryScoped("instructions-cwd-")
      yield* writeFile(`${cwd}/AGENTS.md`, "  \n")
      yield* writeFile(`${cwd}/CLAUDE.md`, "fallback rules")
      const files = testToolContext({ home, cwd }).Files
      expect(yield* readProjectInstructions(files, { cwd, home })).toBe("fallback rules")
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  it.scopedLive("the Claude user file stands in only when every gent location is empty", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const cwd = yield* makeTempDirectoryScoped("instructions-cwd-")
      yield* writeFile(`${home}/.claude/CLAUDE.md`, "global rules")
      const files = testToolContext({ home, cwd }).Files
      expect(yield* readProjectInstructions(files, { cwd, home })).toBe("global rules")
      yield* writeFile(`${cwd}/AGENTS.md`, "project rules")
      expect(yield* readProjectInstructions(files, { cwd, home })).toBe("project rules")
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  it.scopedLive("no file at all yields no prompt section", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const cwd = yield* makeTempDirectoryScoped("instructions-cwd-")
      const files = testToolContext({ home, cwd }).Files
      const text = yield* readProjectInstructions(files, { cwd, home })
      expect(text).toBe("")
      expect(projectInstructionsSection(text)).toEqual([])
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  // The shipped preset carries @gent/instructions, so this is the production path.
  it.scopedLive("an AGENTS.md edited between turns reaches the next system prompt", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDirectoryScoped("instructions-rpc-")
      yield* writeFile(`${cwd}/AGENTS.md`, "Answer in Latin.")
      const prompts: Array<string> = []
      const providerLayer = LanguageModelLayers.testStream((options) => {
        prompts.push(systemText(Prompt.make(options.prompt)))
        return Effect.succeed(
          Stream.fromIterable([textDeltaPart("ok"), finishPart({ finishReason: "stop" })]),
        )
      })
      const { client, sessionId, branchId } = yield* createRpcHarness({
        ...e2ePreset,
        providerLayer,
        cwd,
      })
      const settle = (label: string) =>
        waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) => snapshot.runtime._tag === "Idle",
          15_000,
          label,
        )
      yield* client.message.send({ sessionId, branchId, content: "first" })
      yield* settle("first turn settles")
      yield* writeFile(`${cwd}/AGENTS.md`, "Answer in Greek.")
      yield* client.message.send({ sessionId, branchId, content: "second" })
      yield* settle("second turn settles")
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toContain("# Project Instructions\n\nAnswer in Latin.")
      expect(prompts[0]).not.toContain("Answer in Greek.")
      expect(prompts[1]).toContain("# Project Instructions\n\nAnswer in Greek.")
      // The section keeps its place after the environment section.
      expect(prompts[1]!.indexOf("# Environment")).toBeLessThan(
        prompts[1]!.indexOf("# Project Instructions"),
      )
    }).pipe(Effect.timeout("20 seconds"), Effect.provide(BunFileSystem.layer)),
  )
})
