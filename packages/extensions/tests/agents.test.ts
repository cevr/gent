/**
 * The agents extension owns the persona sections and reads project
 * instructions from `AGENTS.md` (or `CLAUDE.md`) on every turn.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, FileSystem, Stream } from "effect"
import { compileSystemPrompt } from "@gent/core-internal/domain/capability.js"
import { BunFileSystem } from "@effect/platform-bun"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textDeltaPart,
  waitFor,
} from "@gent/core-internal/test-utils/language-model.js"
import {
  createRpcHarness,
  testLeafContext,
  testToolContext,
} from "@gent/core-internal/test-utils/index.js"
import { ExtensionContext } from "@gent/core/extensions/api"
import {
  basePromptSections,
  main,
  projectInstructionsSection,
  readProjectInstructions,
} from "../src/agents"
import { e2ePreset } from "./helpers/test-preset.js"

const systemText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .filter((message): message is Prompt.SystemMessage => message.role === "system")
    .map((message) => message.content)
    .join("\n")

/** The helpers read the paths and Files facade off the context, as a turn does. */
const instructionsIn = (home: string, cwd: string) =>
  readProjectInstructions().pipe(
    Effect.provideService(ExtensionContext, testLeafContext(testToolContext({ home, cwd }))),
  )

const writeFile = (path: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true })
    yield* fs.writeFileString(path, content)
  })

describe("agents extension", () => {
  it.effect("the persona is four sections ahead of the environment", () =>
    Effect.sync(() => {
      expect(basePromptSections.map((section) => section.id)).toEqual([
        "identity",
        "work",
        "communication",
        "boundaries",
      ])
      expect(basePromptSections.every((section) => section.priority < 60)).toBe(true)
      const compiled = compileSystemPrompt(basePromptSections)
      expect(compiled).toContain("You are Gent, a general purpose agent.")
      expect(compiled).toContain("A child inherits your agent and model")
      expect(compiled).toContain("Never revert changes you did not make.")
      expect(String(main.name)).toBe("main")
    }),
  )
})

describe("project instructions", () => {
  it.scopedLive("joins home, project and project-local files in prompt order", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const cwd = yield* makeTempDirectoryScoped("instructions-cwd-")
      yield* writeFile(`${home}/.gent/AGENTS.md`, "home rules\n")
      yield* writeFile(`${cwd}/CLAUDE.md`, "project rules")
      yield* writeFile(`${cwd}/.gent/AGENTS.md`, "local rules")
      expect(yield* instructionsIn(home, cwd)).toBe(
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
      expect(yield* instructionsIn(home, cwd)).toBe("fallback rules")
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  it.scopedLive("the Claude user file stands in only when every gent location is empty", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const cwd = yield* makeTempDirectoryScoped("instructions-cwd-")
      yield* writeFile(`${home}/.claude/CLAUDE.md`, "global rules")
      expect(yield* instructionsIn(home, cwd)).toBe("global rules")
      yield* writeFile(`${cwd}/AGENTS.md`, "project rules")
      expect(yield* instructionsIn(home, cwd)).toBe("project rules")
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  it.scopedLive("no file at all yields no prompt section", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const cwd = yield* makeTempDirectoryScoped("instructions-cwd-")
      const text = yield* instructionsIn(home, cwd)
      expect(text).toBe("")
      expect(projectInstructionsSection(text)).toEqual([])
    }).pipe(Effect.provide(BunFileSystem.layer)),
  )

  // The shipped preset carries @gent/agents, so this is the production path.
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
