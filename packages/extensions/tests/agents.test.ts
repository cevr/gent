import { describe, expect, it, test } from "effect-bun-test"
import { Effect, FileSystem, Stream } from "effect"
import {
  finishPart,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  textDeltaPart,
  waitFor,
  createRpcHarness,
  systemTextOf,
  testLeafContext,
  testToolContext,
} from "@gent/core/test-utils"
import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { ExtensionContext } from "@gent/core/extensions/api"
import {
  basePromptSections,
  main,
  projectInstructionsSection,
  readProjectInstructions,
} from "../src/agents"
import { e2ePreset } from "./helpers/test-preset.js"

/**
 * The agents extension owns the persona sections and reads project
 * instructions from `AGENTS.md` (or `CLAUDE.md`) on every turn.
 */

/** The helpers read home and cwd off the context and files off the platform, as a turn does. */
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
  test("the persona is four sections ahead of the environment", () => {
    expect(basePromptSections.map((section) => section.id)).toEqual([
      "identity",
      "work",
      "communication",
      "boundaries",
    ])
    expect(basePromptSections.every((section) => section.priority < 60)).toBe(true)
    const compiled = basePromptSections.map((section) => section.content).join("\n\n")
    expect(compiled).toContain("You are Gent, a general purpose agent.")
    expect(compiled).toContain("For slow or independent work, start it")
    expect(compiled).toContain("Never revert changes you did not make.")
    expect(String(main.name)).toBe("main")
  })

  test("the default agent asks for high effort, the level each model clamps from", () => {
    expect(main.reasoningEffort).toBe("high")
  })
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
    }).pipe(Effect.provide(BunServices.layer)),
  )

  // Launched from home, the project's `.gent` is the user's: one file, read once.
  it.scopedLive("a session started in home reads ~/.gent/AGENTS.md once", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const fs = yield* FileSystem.FileSystem
      yield* writeFile(`${home}/.gent/AGENTS.md`, "home rules")
      expect(yield* instructionsIn(home, home)).toBe("home rules")
      // A link to home is home too.
      const link = `${yield* makeTempDirectoryScoped("instructions-link-")}/home`
      yield* fs.symlink(home, link)
      expect(yield* instructionsIn(home, link)).toBe("home rules")
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive(
    "a session in a subdirectory reads each directory's file up to the git root, root first",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("instructions-home-")
        const root = yield* makeTempDirectoryScoped("instructions-repo-")
        // A worktree's `.git` is a file; it marks the root as a directory does.
        yield* writeFile(`${root}/.git`, "gitdir: /nonexistent/loop-probe-x\n")
        yield* writeFile(`${root}/AGENTS.md`, "root rules")
        yield* writeFile(`${root}/packages/core/CLAUDE.md`, "core rules")
        expect(yield* instructionsIn(home, `${root}/packages/core`)).toBe(
          "root rules\n---\ncore rules",
        )
        // A link to the subdirectory walks up from the directory it names.
        const links = yield* makeTempDirectoryScoped("instructions-links-")
        yield* (yield* FileSystem.FileSystem).symlink(`${root}/packages/core`, `${links}/core`)
        expect(yield* instructionsIn(home, `${links}/core`)).toBe("root rules\n---\ncore rules")
        // Outside a git work tree only the session's own directory is read.
        const outer = yield* makeTempDirectoryScoped("instructions-outer-")
        yield* writeFile(`${outer}/AGENTS.md`, "outer rules")
        yield* writeFile(`${outer}/sub/AGENTS.md`, "sub rules")
        expect(yield* instructionsIn(home, `${outer}/sub`)).toBe("sub rules")
      }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("an empty AGENTS.md defers to CLAUDE.md beside it", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const cwd = yield* makeTempDirectoryScoped("instructions-cwd-")
      yield* writeFile(`${cwd}/AGENTS.md`, "  \n")
      yield* writeFile(`${cwd}/CLAUDE.md`, "fallback rules")
      expect(yield* instructionsIn(home, cwd)).toBe("fallback rules")
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("the Claude user file stands in only when every gent location is empty", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const cwd = yield* makeTempDirectoryScoped("instructions-cwd-")
      yield* writeFile(`${home}/.claude/CLAUDE.md`, "global rules")
      expect(yield* instructionsIn(home, cwd)).toBe("global rules")
      yield* writeFile(`${cwd}/AGENTS.md`, "project rules")
      expect(yield* instructionsIn(home, cwd)).toBe("project rules")
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("no file at all yields no prompt section", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("instructions-home-")
      const cwd = yield* makeTempDirectoryScoped("instructions-cwd-")
      const text = yield* instructionsIn(home, cwd)
      expect(text).toBe("")
      expect(projectInstructionsSection(text)).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  // The shipped preset carries @gent/agents, so this is the production path.
  it.scopedLive("an AGENTS.md edited between turns reaches the next system prompt", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDirectoryScoped("instructions-rpc-")
      yield* writeFile(`${cwd}/AGENTS.md`, "Answer in Latin.")
      const prompts: Array<string> = []
      const providerLayer = LanguageModelLayers.testStream((options) => {
        prompts.push(systemTextOf(options.prompt))
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
