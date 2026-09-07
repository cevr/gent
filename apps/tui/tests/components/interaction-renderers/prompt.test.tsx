/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect, FileSystem, Option } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { BranchId, InteractionRequestId, SessionId } from "@gent/core-internal/domain/ids"
import type { ActiveInteraction, ApprovalResult } from "@gent/core-internal/domain/event"
import { PromptRenderer } from "../../../src/components/interaction-renderers/prompt"
import { destroyRenderSetup, renderWithProviders } from "../../render-harness-boundary"
import { waitForRenderedFrame } from "../../helpers-boundary"
import { EnvProvider } from "../../../src/env/context"

const interaction = (text: string) =>
  ({
    _tag: "InteractionPresented",
    sessionId: SessionId.make("s"),
    branchId: BranchId.make("b"),
    requestId: InteractionRequestId.make("req-1"),
    text,
  }) satisfies ActiveInteraction

describe("PromptRenderer", () => {
  it.scopedLive.layer(BunFileSystem.layer)(
    "Edit returns the content saved by the external editor",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "gent-review-editor-" })
        const editorPath = `${dir}/editor.js`
        yield* fs.writeFileString(
          editorPath,
          'await Bun.write(process.argv.at(-1), "Edited review from the editor\\n");',
        )
        const results: ApprovalResult[] = []
        const setup = yield* Effect.promise(() =>
          renderWithProviders(() => (
            <EnvProvider
              env={{
                visual: Option.some(`bun ${editorPath}`),
                editor: Option.none(),
                shutdown: () => {},
              }}
            >
              <PromptRenderer
                event={{
                  ...interaction("Original review"),
                  metadata: { type: "prompt", mode: "review", title: "Edit review" },
                }}
                resolve={(result) => results.push(result)}
              />
            </EnvProvider>
          )),
        )
        setup.mockInput.pressArrow("down")
        setup.mockInput.pressArrow("down")
        setup.mockInput.pressEnter()
        yield* Effect.promise(() =>
          waitForRenderedFrame(setup, () => results.length > 0, "edited review reply"),
        )
        expect(results).toEqual([
          { approved: true, notes: "edit", editedContent: "Edited review from the editor\n" },
        ])
        destroyRenderSetup(setup)
      }),
  )

  it.live("renders review content with yes/no", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <PromptRenderer
              event={
                {
                  ...interaction("Here is the generated code"),
                  metadata: {
                    type: "prompt",
                    mode: "confirm",
                    title: "Code Review",
                  },
                } satisfies ActiveInteraction
              }
              resolve={(r) => results.push(r)}
            />
          ),
          { width: 80, height: 24 },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (f) => f.includes("Code Review"), "prompt renderer"),
      )
      expect(frame).toContain("Code Review")
      expect(frame).toContain("Here is the generated code")
      expect(frame).toContain("Yes")
      expect(frame).toContain("No")
      destroyRenderSetup(setup)
    }),
  )
})
