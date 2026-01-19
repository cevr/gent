import { Context, Effect, Layer, Schema } from "effect"
import { FileSystem, Path } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"

// Skill Schema

export class Skill extends Schema.Class<Skill>("Skill")({
  name: Schema.String,
  description: Schema.String,
  filePath: Schema.String,
  content: Schema.String,
}) {}

// Skills Service Interface

export interface SkillsService {
  readonly list: () => Effect.Effect<ReadonlyArray<Skill>>
  readonly get: (name: string) => Effect.Effect<Skill | undefined>
  readonly reload: () => Effect.Effect<void, PlatformError>
}

// Skills Service Tag

export class Skills extends Context.Tag("Skills")<Skills, SkillsService>() {
  static Live = (options: {
    cwd: string
    globalDir: string
    claudeSkillsDir?: string
    ignored?: ReadonlyArray<string>
  }): Layer.Layer<Skills, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Layer.scoped(
      Skills,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        let skills: Skill[] = []

        const loadSkillsFromDir = (
          dir: string
        ): Effect.Effect<Skill[], PlatformError> =>
          Effect.gen(function* () {
            const exists = yield* fs.exists(dir)
            if (!exists) return []

            const entries = yield* fs.readDirectory(dir)
            const result: Skill[] = []

            for (const entry of entries) {
              const filePath = path.join(dir, entry)
              const stat = yield* fs.stat(filePath)

              if (stat.type === "File" && entry.endsWith(".md")) {
                const content = yield* fs.readFileString(filePath)
                const parsed = parseSkillFile(content, entry)
                if (parsed && !options.ignored?.includes(parsed.name)) {
                  result.push(
                    new Skill({
                      ...parsed,
                      filePath,
                    })
                  )
                }
              } else if (stat.type === "Directory") {
                // Check for SKILL.md in subdirectory
                const skillPath = path.join(filePath, "SKILL.md")
                const skillExists = yield* fs.exists(skillPath)
                if (skillExists) {
                  const content = yield* fs.readFileString(skillPath)
                  const parsed = parseSkillFile(content, entry)
                  if (parsed && !options.ignored?.includes(parsed.name)) {
                    result.push(
                      new Skill({
                        ...parsed,
                        filePath: skillPath,
                      })
                    )
                  }
                }
              }
            }

            return result
          })

        const loadAllSkills = Effect.gen(function* () {
          const dirs = [
            path.join(options.cwd, ".gent", "skills"),
            options.globalDir,
          ]

          // Add Claude Code skills dir if provided
          if (options.claudeSkillsDir) {
            dirs.push(options.claudeSkillsDir)
          }

          const allSkills: Skill[] = []
          const seenNames = new Set<string>()

          // Load from all dirs, project takes precedence
          for (const dir of dirs) {
            const dirSkills = yield* loadSkillsFromDir(dir)
            for (const skill of dirSkills) {
              if (!seenNames.has(skill.name)) {
                seenNames.add(skill.name)
                allSkills.push(skill)
              }
            }
          }

          return allSkills
        })

        // Initial load
        skills = yield* loadAllSkills

        return {
          list: () => Effect.succeed(skills),
          get: (name) => Effect.succeed(skills.find((s) => s.name === name)),
          reload: () =>
            loadAllSkills.pipe(
              Effect.tap((loaded) =>
                Effect.sync(() => {
                  skills = loaded
                })
              ),
              Effect.asVoid
            ),
        }
      })
    )

  static Test = (
    testSkills: ReadonlyArray<Skill> = []
  ): Layer.Layer<Skills> =>
    Layer.succeed(Skills, {
      list: () => Effect.succeed(testSkills),
      get: (name) => Effect.succeed(testSkills.find((s) => s.name === name)),
      reload: () => Effect.void as Effect.Effect<void, PlatformError>,
    })
}

// Parse skill file with frontmatter

function parseSkillFile(
  content: string,
  filename: string
): { name: string; description: string; content: string } | null {
  const lines = content.split("\n")

  // Check for YAML frontmatter
  if (lines[0]?.trim() === "---") {
    const endIndex = lines.findIndex((l, i) => i > 0 && l.trim() === "---")
    if (endIndex > 0) {
      const frontmatter = lines.slice(1, endIndex).join("\n")
      const body = lines.slice(endIndex + 1).join("\n").trim()

      // Simple YAML parsing for name and description
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

      if (nameMatch && descMatch) {
        return {
          name: nameMatch[1]!.trim(),
          description: descMatch[1]!.trim(),
          content: body,
        }
      }
    }
  }

  // No frontmatter - use filename as name
  const name = filename.replace(/\.md$/, "").replace(/^SKILL$/, filename.replace(/\.md$/, ""))

  // Try to extract description from first paragraph
  const firstPara = content.split("\n\n")[0]?.replace(/^#.*\n/, "").trim()

  return {
    name,
    description: firstPara?.slice(0, 100) ?? `Skill: ${name}`,
    content,
  }
}

// Format skills for system prompt

export const formatSkillsForPrompt = (skills: ReadonlyArray<Skill>): string => {
  if (skills.length === 0) return ""

  const skillsList = skills
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join("\n")

  return `<available_skills>
${skillsList}

To use a skill, ask the user to invoke it with: /skill <skill-name>
</available_skills>`
}
