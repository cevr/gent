/** @jsxImportSource @opentui/solid */

import { describe, test, expect } from "bun:test"
import { Composer } from "../src/components/composer"
import { renderFrame, renderWithProviders } from "./render-harness"

describe("Composer renderer", () => {
  test("plain enter submits and clears the composer", async () => {
    const submitted: Array<{ content: string; mode?: "queue" | "interject" }> = []
    const setup = await renderWithProviders(() => (
      <Composer
        onSubmit={(content, mode) => {
          submitted.push({ content, mode })
        }}
      />
    ))

    setup.mockInput.pressKeys(["h", "i"])
    await setup.renderOnce()
    expect(renderFrame(setup)).toContain("❯ hi")

    setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()

    expect(submitted).toEqual([{ content: "hi", mode: "queue" }])
    expect(renderFrame(setup)).not.toContain("❯ hi")
  })

  test("suspended composer blocks enter submission", async () => {
    const submitted: string[] = []
    const setup = await renderWithProviders(() => (
      <Composer
        suspended
        onSubmit={(content) => {
          submitted.push(content)
        }}
      />
    ))

    setup.mockInput.pressKeys(["h", "i"])
    setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()

    expect(submitted).toEqual([])
    expect(renderFrame(setup)).toContain("❯ hi")
  })

  test("slash trigger renders the command popup", async () => {
    const setup = await renderWithProviders(
      () => (
        <Composer onSubmit={() => {}}>
          <Composer.Autocomplete />
        </Composer>
      ),
      {
        width: 90,
        height: 28,
      },
    )

    setup.mockInput.pressKeys(["/"])
    await setup.renderOnce()

    const frame = renderFrame(setup)
    expect(frame).toContain("Commands")
    expect(frame).toContain("/agent")
    expect(frame).toContain("/clear")
  })
})
