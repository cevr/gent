/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { For } from "solid-js"
import { Effect } from "effect"
import type { SkillContent } from "@gent/sdk"
import { createMockClient, renderFrame, renderWithProviders } from "./render-harness"
import { useSkills } from "../src/hooks/use-skills"

function SkillsProbe() {
  const skills = useSkills()
  return (
    <box flexDirection="column">
      <For each={skills.skills()}>{(skill) => <text>{skill.name}</text>}</For>
    </box>
  )
}

const waitForFrame = async (
  setup: Awaited<ReturnType<typeof renderWithProviders>>,
  predicate: (frame: string) => boolean,
  remaining = 10,
): Promise<string> => {
  await setup.renderOnce()
  const frame = renderFrame(setup)
  if (predicate(frame)) return frame
  if (remaining <= 1) {
    throw new Error(`skills frame did not reach expected condition; got:\n${frame}`)
  }
  return waitForFrame(setup, predicate, remaining - 1)
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
    await waitForFrame(alpha, (frame) => frame.includes("alpha-skill"))
    alpha.renderer.destroy()

    const beta = await renderWithProviders(() => <SkillsProbe />, {
      client: clientWithSkills([skill("beta-skill")]),
    })
    const frame = await waitForFrame(beta, (next) => next.includes("beta-skill"))

    expect(frame).toContain("beta-skill")
    expect(frame).not.toContain("alpha-skill")
  })
})
