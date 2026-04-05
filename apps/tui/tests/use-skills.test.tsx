/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { For } from "solid-js"
import { Effect } from "effect"
import type { SkillContent } from "@gent/sdk"
import { createMockClient, renderWithProviders } from "./render-harness"
import { waitForRenderedFrame } from "./helpers"
import { useSkills } from "../src/hooks/use-skills"

function SkillsProbe() {
  const skills = useSkills()
  return (
    <box flexDirection="column">
      <For each={skills.skills()}>{(skill) => <text>{skill.name}</text>}</For>
    </box>
  )
}

const skill = (name: string): SkillContent => ({
  name,
  description: `${name} description`,
  content: `${name} content`,
  filePath: `/tmp/${name}.md`,
})

const clientWithSkills = (skills: readonly SkillContent[]) =>
  createMockClient({
    skill: {
      list: () => Effect.succeed(skills),
    },
  })

describe("useSkills", () => {
  test("scopes shared skill state to the current registry", async () => {
    const alpha = await renderWithProviders(() => <SkillsProbe />, {
      client: clientWithSkills([skill("alpha-skill")]),
    })
    await waitForRenderedFrame(alpha, (frame) => frame.includes("alpha-skill"))
    alpha.renderer.destroy()

    const beta = await renderWithProviders(() => <SkillsProbe />, {
      client: clientWithSkills([skill("beta-skill")]),
    })
    const frame = await waitForRenderedFrame(beta, (next) => next.includes("beta-skill"))

    expect(frame).toContain("beta-skill")
    expect(frame).not.toContain("alpha-skill")
  })
})
