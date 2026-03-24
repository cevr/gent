/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { createEffect } from "solid-js"
import { CommandPalette } from "../src/components/command-palette"
import { useCommand } from "../src/command"
import { renderFrame, renderWithProviders } from "./render-harness"

function OpenPaletteOnMount() {
  const command = useCommand()
  createEffect(() => {
    command.openPalette()
  })
  return <CommandPalette />
}

describe("CommandPalette renderer", () => {
  test("opens the theme submenu through keyboard navigation and activation", async () => {
    const setup = await renderWithProviders(() => <OpenPaletteOnMount />, {
      width: 90,
      height: 28,
    })

    expect(renderFrame(setup)).toContain("Commands")

    setup.mockInput.pressArrow("down")
    await setup.renderOnce()

    setup.mockInput.pressKey("RETURN")
    await setup.renderOnce()

    const frame = renderFrame(setup)
    expect(frame).toContain("System")
    expect(frame).toContain("Dark")
    expect(frame).toContain("Light")
  })
})
