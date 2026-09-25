import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, FileSystem, Path, Stream } from "effect"
import { BunServices } from "@effect/platform-bun"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  createRpcHarness,
  LanguageModelLayers,
  testAgent,
  testTurnExtension,
  textStep,
  toolCallStep,
} from "@gent/core/test-utils"
import SessionNotesExtension from "../extensions/session-notes.js"

/**
 * Acceptance for the one-file authoring reference: the example loads through
 * the public entries only and runs its tool, slash request, and turn
 * projection over the full RPC path.
 */

const sessionNotesSourceUrl = new URL("../extensions/session-notes.ts", import.meta.url)

/** The system text a model call received: where turn projections land. */
const systemText = (prompt: Prompt.RawInput): string =>
  [...Prompt.make(prompt).content]
    .filter((message): message is Prompt.SystemMessage => message.role === "system")
    .map((message) => message.content)
    .join("\n")

describe("session notes reference extension", () => {
  it.scopedLive(
    "a note the model adds reaches the slash request and the next turn's prompt",
    () =>
      Effect.gen(function* () {
        const prompts: Array<string> = []
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("session_note_add", { text: "ship the authoring loop" }),
          textStep("noted"),
          {
            ...textStep("you noted one thing"),
            assertOptions: (options) => {
              prompts.push(systemText(options.prompt))
            },
          },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: [testAgent],
          extensionInputs: [testTurnExtension, SessionNotesExtension],
          providerLayer,
        })

        const commands = yield* client.extension.listSlashCommands({ sessionId })
        const notes = commands.find((command) => command.name === "notes")
        expect(notes?.displayName).toBe("Session Notes")
        expect(notes?.capabilityId).toBe("session-notes-summary")

        const summary = () =>
          client.extension.request({
            sessionId,
            branchId,
            extensionId: notes!.extensionId,
            capabilityId: notes!.capabilityId,
            input: {},
          })
        expect(yield* summary()).toBe("No session notes yet.")

        const turnCompleted = (count: number) =>
          client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(({ event }) => event._tag === "TurnCompleted"),
            Stream.take(count),
            Stream.runDrain,
            Effect.forkScoped,
          )

        const first = yield* turnCompleted(1)
        yield* client.message.send({ sessionId, branchId, content: "remember this" })
        yield* Fiber.join(first)
        expect(yield* summary()).toBe("1. ship the authoring loop")

        // Notes belong to the session that wrote them; another session in the same process has none.
        const other = yield* client.session.create({})
        const otherSummary = yield* client.extension.request({
          sessionId: other.sessionId,
          branchId: other.branchId,
          extensionId: notes!.extensionId,
          capabilityId: notes!.capabilityId,
          input: {},
        })
        expect(otherSummary).toBe("No session notes yet.")

        // The event stream replays the first turn, so the second completion is the second one seen.
        const second = yield* turnCompleted(2)
        yield* client.message.send({ sessionId, branchId, content: "what did I note?" })
        yield* Fiber.join(second)
        yield* controls.assertDone
        expect(prompts).toHaveLength(1)
        // The projection renders each note as a "- " line in the system text.
        expect(prompts.at(-1)).toContain("- ship the authoring loop")
      }).pipe(Effect.timeout("8 seconds")),
    10_000,
  )

  it.live("the reference source imports only the public extension API", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const source = yield* fs.readFileString(yield* path.fromFileUrl(sessionNotesSourceUrl))
      expect(source).toContain('from "@gent/core/extensions/api"')
      expect(source).not.toContain("@gent/core/host")
      expect(source).not.toContain("@gent/core/src")
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
