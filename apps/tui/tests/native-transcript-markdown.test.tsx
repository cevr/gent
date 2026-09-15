/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Option } from "effect"
import { onCleanup } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { SyntaxStyle, type CliRendererExternalOutputEvent } from "@opentui/core"
import { NativeTranscript } from "../src/components/native-transcript"
import { MessageList, type Message } from "../src/components/message-list"
import { renderWithProviders } from "./render-harness-boundary"

const syntaxStyle = () => SyntaxStyle.create()
const absent = Option.getOrUndefined(Option.none())

const assistant = (id: string, content: string): Message => ({
  _tag: "regular-message",
  id,
  role: "assistant",
  content,
  reasoning: "",
  images: [],
  createdAt: 0,
  toolCalls: absent,
  segments: [{ _tag: "text", content }],
})

describe("native transcript markdown", () => {
  it.live("a message enters native history with its markdown concealed", () =>
    Effect.gen(function* () {
      const savedText: string[] = []
      const firstCommit = yield* Deferred.make<void>()
      const body = Array.from({ length: 12 }, (_, index) => `line ${index + 1} of the answer`).join(
        "\n\n",
      )
      const items = [
        assistant("first", `## Known, pre-existing\n${body}\n\nsee \`money.test.ts\` for the rest`),
        assistant("second", "ANSWER-END"),
      ]
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => {
            const renderer = useRenderer()
            const capture = (event: CliRendererExternalOutputEvent) => {
              savedText.push(new TextDecoder().decode(event.snapshot.getRealCharBytes(false)))
              Deferred.doneUnsafe(firstCommit, Effect.void)
            }
            renderer.on("external_output", capture)
            onCleanup(() => renderer.off("external_output", capture))
            return (
              <NativeTranscript
                items={items}
                streaming={false}
                footerHeight={3}
                expanded={false}
                disclosure="collapsed"
                displayRevision={0}
                overlayOpen={false}
                renderItems={(visible) => (
                  <MessageList
                    items={visible}
                    disclosure="collapsed"
                    syntaxStyle={syntaxStyle}
                    streaming={false}
                  />
                )}
              >
                <box />
              </NativeTranscript>
            )
          },
          { width: 60, height: 14 },
        ),
      )
      yield* Effect.promise(() => setup.flush())
      yield* Deferred.await(firstCommit)
      yield* Effect.promise(() => setup.flush())
      const history = savedText.join("")
      expect(history).toContain("Known, pre-existing")
      expect(history).toContain("money.test.ts")
      expect(history).not.toContain("## ")
      expect(history).not.toContain("`")
    }).pipe(Effect.timeout("10 seconds")),
  )
})
