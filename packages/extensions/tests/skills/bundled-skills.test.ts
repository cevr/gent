import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Option, Path } from "effect"
import { installBundledSkills } from "../../src/skills/bundled-skills.js"
import { bundledSkillFiles } from "../../src/skills/bundled-sources.js"
import { Skills } from "../../src/skills/skills.js"

describe("bundled skills", () => {
  it.scopedLive("concurrent profiles publish one complete bundle of readable files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-bundled-skills-" })
      const roots = yield* Effect.all([installBundledSkills(home), installBundledSkills(home)], {
        concurrency: 2,
      })
      expect(roots[0]).toBe(roots[1])
      for (const [relativePath, content] of bundledSkillFiles) {
        expect(yield* fs.readFileString(path.join(roots[0], relativePath))).toBe(content)
      }
      expect(yield* fs.readDirectory(path.dirname(roots[0]))).toHaveLength(1)
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive(
    "user skills override bundled defaults and explicit scope still selects global",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-skill-home-" })
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gent-skill-project-" })
        const globalDir = path.join(home, ".gent", "skills", "principles")
        const localDir = path.join(cwd, ".gent", "skills", "principles")
        for (const dir of [globalDir, localDir]) yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.writeFileString(
          path.join(globalDir, "SKILL.md"),
          "---\nname: principles\ndescription: User principles\n---\nGLOBAL-PRINCIPLES",
        )
        yield* fs.writeFileString(
          path.join(localDir, "SKILL.md"),
          "---\nname: principles\ndescription: Project principles\n---\nLOCAL-PRINCIPLES",
        )
        yield* Effect.gen(function* () {
          const skills = yield* Skills
          const local = yield* skills.get("principles", Option.none())
          const global = yield* skills.get("$principles:global", Option.none())
          expect(Option.getOrThrow(local).content).toContain("LOCAL-PRINCIPLES")
          expect(Option.getOrThrow(global).content).toContain("GLOBAL-PRINCIPLES")
          expect((yield* skills.list).filter((skill) => skill.name === "principles")).toHaveLength(
            2,
          )
          // oxlint-disable-next-line effect/noInlineProvide -- This test constructs the real service after acquiring its scoped fixture directories.
        }).pipe(Effect.provide(Skills.Live({ home, cwd })))
      }).pipe(Effect.provide(BunServices.layer)),
  )
})
