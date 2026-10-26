import { describe, expect, it } from "effect-bun-test"
import {
  ConfigProvider,
  type Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Ref,
  Schedule,
  type Scope,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import { CredentialSlot, ExtensionContext, type LaneReport } from "@gent/core/extensions/api"
import {
  collectTestContributions,
  makeTempDirectoryScoped,
  testLeafContext,
  testToolContext,
} from "@gent/core/test-utils"
import { BranchId, MessageId, SessionId } from "@gent/core/protocol"
import { main as builtinAgent } from "../src/agents.js"
import { LOGIN_ALERT_COMMAND, LoginAlertExtension } from "../src/login-alert.js"

const work = CredentialSlot.make("work")

/** One provider's lanes with `work` lost at `since`, or no loss. */
const report = (loss: Option.Option<{ readonly since: number }>): LaneReport => ({
  providers: [
    {
      provider: "anthropic",
      scope: [work],
      accounts: [
        {
          slot: work,
          windows: [],
          held: false,
          ...Option.match(loss, {
            onNone: () => ({}),
            onSome: ({ since }) => ({ loginLost: { since, reason: "Rejected" as const } }),
          }),
        },
      ],
      load: 0,
      fuelPerHour: 0,
      laneHours: 0,
      models: [],
    },
  ],
})

/**
 * The installed extension's turn-end hook over its server resource, with
 * the lanes `lanes` holds. `command` is the environment's alert command;
 * each `end` reads the lanes and counts the read in `reads`.
 */
const installed = (command: Option.Option<string>, lanes: Ref.Ref<LaneReport>) =>
  Effect.gen(function* () {
    const contributions = yield* collectTestContributions(LoginAlertExtension.setup)
    const resource = contributions.resources?.find(
      (found) => found.id === "@gent/login-alert/alerted",
    )
    const after = (contributions.hooks ?? []).find(
      (slot): slot is Extract<typeof slot, { readonly kind: "turnAfter" }> =>
        slot.kind === "turnAfter",
    )
    if (Predicate.isUndefined(resource) || Predicate.isUndefined(after)) {
      return yield* Effect.die("the login-alert extension registers no resource or no turnAfter")
    }
    const build: Effect.Effect<Context.Context<never>, never, Scope.Scope> = Layer.build(
      resource.layer,
    ).pipe(Effect.orDie)
    const services = yield* build
    const reads = yield* Ref.make(0)
    const ctx = testLeafContext({
      ...testToolContext(),
      Accounts: {
        ...testToolContext().Accounts,
        lanes: Ref.update(reads, (count) => count + 1).pipe(Effect.andThen(Ref.get(lanes))),
      },
    })
    const env = Option.match(command, {
      onNone: () => ({}),
      onSome: (value) => ({ [LOGIN_ALERT_COMMAND]: value }),
    })
    const end = after.hook
      .handler({
        sessionId: SessionId.make("alert-session"),
        branchId: BranchId.make("alert-branch"),
        messageId: MessageId.make("alert-message"),
        joinedMessageIds: new Set(),
        startedAtMs: 0,
        durationMs: 10,
        agentName: builtinAgent.name,
        interrupted: false,
        streamFailed: true,
        retryAt: Option.none(),
        unanswered: true,
        readNotices: new Set(),
        usage: {
          known: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: Option.none(),
          },
          complete: true,
        },
      })
      .pipe(
        Effect.provideService(ExtensionContext, ctx),
        Effect.provideContext(services),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      )
    return { end, reads: Ref.get(reads) }
  })

/**
 * A command that appends each alert's text to `alerts.log` in a fresh
 * directory, after `delay` seconds; `arrived` waits up to 10 s for `count`
 * alerts and fails if they never come.
 */
const appendingCommand = (delay = 0) =>
  Effect.gen(function* () {
    const directory = yield* makeTempDirectoryScoped("gent-login-alert-")
    const log = (yield* Path.Path).join(directory, "alerts.log")
    const fs = yield* FileSystem.FileSystem
    return {
      command: `sleep ${delay}; printf '%s\\n' "$GENT_LOGIN_ALERT" >> '${log}'`,
      alerts: fs.exists(log).pipe(
        Effect.flatMap((exists) => {
          if (!exists) return Effect.succeed<ReadonlyArray<string>>([])
          return Effect.map(fs.readFileString(log), (text) => text.trim().split("\n"))
        }),
      ),
    }
  })

/** Reads `alerts` until it holds `count` lines; fails after 10 s. */
const arrived = <E>(alerts: Effect.Effect<ReadonlyArray<string>, E>, count: number) =>
  alerts.pipe(
    Effect.repeat({
      until: (lines) => lines.length >= count,
      schedule: Schedule.spaced("20 millis"),
    }),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.die(`fewer than ${count} alerts arrived`),
    }),
  )

const REFUSED = "login! anthropic work refused · sign in with /auth"

describe("lost-login alerts", () => {
  it.scopedLive("a lost login runs the alert command once per loss", () =>
    Effect.gen(function* () {
      const { command, alerts } = yield* appendingCommand()
      const lanes = yield* Ref.make(report(Option.some({ since: 1000 })))
      const { end } = yield* installed(Option.some(command), lanes)
      yield* end
      yield* end
      expect(yield* arrived(alerts, 1)).toEqual([REFUSED])
      // A served step clears the loss; the next loss on the sign-in alerts again.
      yield* Ref.set(lanes, report(Option.none()))
      yield* end
      yield* Ref.set(lanes, report(Option.some({ since: 2000 })))
      yield* end
      expect(yield* arrived(alerts, 2)).toEqual([REFUSED, REFUSED])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("turns that end together alert one loss once", () =>
    Effect.gen(function* () {
      const { command, alerts } = yield* appendingCommand()
      const lanes = yield* Ref.make(report(Option.some({ since: 1000 })))
      const { end } = yield* installed(Option.some(command), lanes)
      yield* Effect.all([end, end, end, end], { concurrency: "unbounded" })
      expect(yield* arrived(alerts, 1)).toEqual([REFUSED])
      // A second alert would have had as long as the first to arrive.
      expect(yield* alerts).toEqual([REFUSED])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("a slow alert command never holds a turn's end", () =>
    Effect.gen(function* () {
      const { command, alerts } = yield* appendingCommand(2)
      const lanes = yield* Ref.make(report(Option.some({ since: 1000 })))
      const { end } = yield* installed(Option.some(command), lanes)
      yield* end.pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.die("the turn's end waited for the alert command"),
        }),
      )
      expect(yield* arrived(alerts, 1)).toEqual([REFUSED])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("with no alert command a turn end reads no lanes", () =>
    Effect.gen(function* () {
      const lanes = yield* Ref.make(report(Option.some({ since: 1000 })))
      const { end, reads } = yield* installed(Option.none(), lanes)
      yield* end
      expect(yield* reads).toBe(0)
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
