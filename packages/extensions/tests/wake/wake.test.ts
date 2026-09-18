/**
 * `wake` is an alarm and `monitor` a poll: the model sets one, answers, and
 * goes idle; when it fires, a user-role `wake` message on the same branch
 * starts the next turn.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect, Exit, FileSystem, Option, Schema } from "effect"
import { BunFileSystem } from "@effect/platform-bun"
import { RuntimeEnvironment } from "@gent/core-internal/runtime/runtime-environment"
import { makeTempDirectoryScoped, waitFor } from "@gent/core-internal/test-utils/fixtures"
import { textStep, toolCallStep } from "@gent/core-internal/test-utils/sequence-steps"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { e2ePreset } from "../helpers/test-preset"
import {
  dueAtOf,
  monitorMessage,
  WAKE_MESSAGE_TYPE,
  WakeEntry,
  wakeMessage,
} from "../../src/wake.js"

const encodeAlarms = Schema.encodeSync(Schema.fromJsonString(Schema.Array(WakeEntry)))

interface MessageLike {
  readonly role: string
  readonly metadata?: { readonly customType?: string }
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

const wakeOf = <M extends MessageLike>(messages: ReadonlyArray<M>): Option.Option<M> =>
  Option.fromUndefinedOr(
    messages.find(
      (message) => message.role === "user" && message.metadata?.customType === WAKE_MESSAGE_TYPE,
    ),
  )

const textOf = (message: Option.Option<MessageLike>): string =>
  Option.match(message, {
    onNone: () => "",
    onSome: (value) =>
      value.parts
        .filter((part) => part.type === "text")
        .map((part) => Option.getOrElse(Option.fromUndefinedOr(part.text), () => ""))
        .join(""),
  })

const hasWake = (messages: ReadonlyArray<MessageLike>): boolean => Option.isSome(wakeOf(messages))

const answered = (messages: ReadonlyArray<MessageLike>, text: string): boolean =>
  messages.some((message) => message.role === "assistant" && textOf(Option.some(message)) === text)

describe("wake", () => {
  it.live("a due time comes from afterSeconds or an ISO time, never both", () =>
    Effect.gen(function* () {
      const now = 1_000_000
      expect(yield* dueAtOf({ afterSeconds: 90 }, now)).toBe(now + 90_000)
      expect(yield* dueAtOf({ at: "1970-01-01T00:20:00.000Z" }, now)).toBe(1_200_000)
      const both = yield* Effect.exit(dueAtOf({ afterSeconds: 1, at: "1970-01-01T00:20:00Z" }, now))
      expect(Exit.isFailure(both)).toBe(true)
      const neither = yield* Effect.exit(dueAtOf({}, now))
      expect(Exit.isFailure(neither)).toBe(true)
      const garbage = yield* Effect.exit(dueAtOf({ at: "tomorrow-ish" }, now))
      expect(Exit.isFailure(garbage)).toBe(true)
      const tooFar = yield* Effect.exit(dueAtOf({ afterSeconds: 25 * 60 * 60 }, now))
      expect(Exit.isFailure(tooFar)).toBe(true)
      expect(wakeMessage({ _tag: "alarm", wakeId: "w1", dueAt: 1_200_000, note: "check CI" })).toBe(
        "Alarm w1 fired at 1970-01-01T00:20:00.000Z. check CI",
      )
      const monitor = WakeEntry.cases.monitor.make({
        wakeId: "m1",
        command: "true",
        everySeconds: 1,
        deadline: 0,
        note: "merge it",
      })
      expect(monitorMessage(monitor, "matched", 3, "ok\n")).toBe(
        "Monitor m1 matched after 3 checks of `true`. merge it\n\nLast output:\nok",
      )
      expect(monitorMessage(monitor, "timed-out", 9, "")).toBe(
        "Monitor m1 timed out after 9 checks of `true` without matching. merge it",
      )
    }),
  )

  it.live(
    "an idle session wakes at the alarm with the note as a user message",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("wake", { afterSeconds: 0.3, note: "check whether CI is green" }),
            textStep("alarm set, going idle"),
            textStep("woke up and checked CI"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "wake me when CI is done" })
          const idle = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              answered(current.messages, "alarm set, going idle"),
            5_000,
            "first turn answered",
          )
          expect(hasWake(idle.messages)).toBe(false)
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              answered(current.messages, "woke up and checked CI"),
            8_000,
            "the alarm queued a wake message and the loop answered it",
          )
          expect(textOf(wakeOf(woken.messages)).endsWith("check whether CI is green")).toBe(true)
          expect(woken.messages.at(-1)?.role).toBe("assistant")
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a past-due alarm left on disk fires on the first turn after a restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* makeTempDirectoryScoped("wake-restart-")
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("hello again"),
            textStep("checked the build as the alarm asked"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extraLayers: [RuntimeEnvironment.Live({ cwd: "/tmp", home, platform: "darwin" })],
          })
          const fs = yield* FileSystem.FileSystem
          yield* fs.makeDirectory(`${home}/.gent/wakes`, { recursive: true })
          yield* fs.writeFileString(
            `${home}/.gent/wakes/${branchId}.json`,
            encodeAlarms([
              { _tag: "alarm", wakeId: "left-over", dueAt: 1_000, note: "check the build" },
            ]),
          )
          yield* client.message.send({ sessionId, branchId, content: "I'm back" })
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              current.messages.at(-1)?.role === "assistant",
            8_000,
            "the stored alarm fired and was answered",
          )
          expect(woken.messages.filter((m) => m.role === "assistant").length).toBe(2)
          expect(yield* fs.readFileString(`${home}/.gent/wakes/${branchId}.json`)).toBe("[]")
        }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a monitor polls its command until it succeeds, then wakes with the output",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* makeTempDirectoryScoped("wake-monitor-")
          const flag = `${dir}/done`
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("monitor", {
              command: `test -f ${flag} && cat ${flag}`,
              everySeconds: 0.1,
              timeoutSeconds: 10,
              note: "read the result file",
            }),
            textStep("watching for the file"),
            textStep("saw the result"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "tell me when it lands" })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              answered(current.messages, "watching for the file"),
            5_000,
            "first turn answered",
          )
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString(flag, "build 42 green")
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              answered(current.messages, "saw the result"),
            8_000,
            "the monitor matched and woke the loop",
          )
          const text = textOf(wakeOf(woken.messages))
          expect(text).toContain("matched after")
          expect(text).toContain("build 42 green")
          expect(text).toContain("read the result file")
        }).pipe(Effect.provide(BunFileSystem.layer), Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a monitor that never matches wakes at its deadline and says so",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("monitor", {
              command: "echo still running; false",
              everySeconds: 0.1,
              timeoutSeconds: 0.35,
              note: "give up and report",
            }),
            textStep("watching"),
            textStep("gave up"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          yield* client.message.send({ sessionId, branchId, content: "watch it" })
          const woken = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              hasWake(current.messages) &&
              answered(current.messages, "gave up"),
            8_000,
            "the monitor timed out and woke the loop",
          )
          const text = textOf(wakeOf(woken.messages))
          expect(text).toContain("timed out after")
          expect(text).toContain("still running")
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )
})
