/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ClientLog } from "../src/utils/client-logger"
import { Auth } from "../src/routes/auth"
import { Route } from "../src/router"
import { createMockClient, createMockRuntime, renderWithProviders } from "./render-harness"

const noop = () => {}
const log: ClientLog = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

describe("Auth route", () => {
  test("loads providers for the selected agent", async () => {
    const calls: Array<{ agentName?: string }> = []
    const client = createMockClient({
      auth: {
        listProviders: (input: { agentName?: string }) => {
          calls.push(input)
          return Effect.succeed([])
        },
        listMethods: () => Effect.succeed({}),
      },
    })
    const runtime = createMockRuntime()

    const setup = await renderWithProviders(
      () => <Auth client={client} runtime={runtime} log={log} agentName="helper:google" />,
      {
        client,
        runtime,
        initialRoute: Route.auth(),
      },
    )

    expect(calls).toEqual([{ agentName: "helper:google" }])
    setup.renderer.destroy()
  })
})
