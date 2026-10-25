/**
 * Lost-login alerts: a sign-in a provider stopped taking runs the owner's
 * command once, so the owner hears of it away from the band. The command is
 * the environment's `GENT_LOGIN_ALERT_COMMAND`, run by `sh -c` with the
 * alert text in `GENT_LOGIN_ALERT`; with no command the extension does
 * nothing. A project cannot set it: only the environment gent starts in.
 */
import {
  Cause,
  Config,
  Context,
  Duration,
  Effect,
  type Fiber,
  Layer,
  Option,
  Predicate,
  Ref,
} from "effect"
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
  ExtensionId,
  type LaneReport,
  LOGIN_LOSS_WORDS,
  runProcess,
} from "@gent/core/extensions/api"

const LOGIN_ALERT_EXTENSION_ID = ExtensionId.make("@gent/login-alert")

/** The environment variable that holds the alert command. */
export const LOGIN_ALERT_COMMAND = "GENT_LOGIN_ALERT_COMMAND"

/** How long one alert command may run before it is stopped. */
const ALERT_TIMEOUT = Duration.seconds(10)

// ── losses already alerted ──────────────────────────────────────────────────

/** One lost login as the band names it, keyed by its first refusal. */
interface LostLogin {
  readonly key: string
  readonly text: string
}

const lostLogins = (report: LaneReport): ReadonlyArray<LostLogin> =>
  report.providers.flatMap((lanes) =>
    lanes.accounts.flatMap((account) => {
      if (Predicate.isUndefined(account.loginLost)) return []
      const { since, reason } = account.loginLost
      return [
        {
          key: [lanes.provider, account.slot, since].join("\u0000"),
          text: `login! ${lanes.provider} ${account.slot} ${LOGIN_LOSS_WORDS[reason]} · sign in with /auth`,
        },
      ]
    }),
  )

interface LoginAlertsService {
  /**
   * The losses in `report` not alerted yet; they count as alerted from now.
   * A loss no longer listed is forgotten, so a later loss on the same
   * sign-in alerts again.
   */
  readonly fresh: (report: LaneReport) => Effect.Effect<ReadonlyArray<LostLogin>>
  /** Runs `effect` on the resource's own scope, so a turn's end never waits for a command. */
  readonly spawn: <R>(
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<Fiber.Fiber<void>, never, R>
}

/**
 * The losses alerted on this server: one alert per loss across every
 * session's turns. A rename moves a loss to a new slot and a changed
 * extension build starts an empty set, so either can alert one loss again.
 */
class LoginAlerts extends Context.Service<LoginAlerts, LoginAlertsService>()(
  "@gent/extensions/src/login-alert/LoginAlerts",
) {}

const LoginAlertsLive: Layer.Layer<LoginAlerts> = Layer.effect(
  LoginAlerts,
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const alerted = yield* Ref.make<ReadonlySet<string>>(new Set())
    return LoginAlerts.of({
      fresh: (report) =>
        Ref.modify(alerted, (before): readonly [ReadonlyArray<LostLogin>, ReadonlySet<string>] => {
          const listed = lostLogins(report)
          return [
            listed.filter((loss) => !before.has(loss.key)),
            new Set(listed.map((loss) => loss.key)),
          ]
        }),
      spawn: (effect) => Effect.forkIn(effect, scope),
    })
  }),
)

const LoginAlertsResource = defineResource({
  id: "@gent/login-alert/alerted",
  scope: "server",
  layer: LoginAlertsLive,
})

// ── the turn-end check ──────────────────────────────────────────────────────

const runAlert = (command: string, text: string) =>
  runProcess("sh", ["-c", command], {
    env: { GENT_LOGIN_ALERT: text },
    extendEnv: true,
    stdin: "ignore",
    timeout: ALERT_TIMEOUT,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.exitCode === 0) return Effect.void
      return Effect.logWarning("login-alert.command.failed").pipe(
        Effect.annotateLogs({ exitCode: result.exitCode, stderr: result.stderr.trim() }),
      )
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("login-alert.command.failed").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(cause) }),
      ),
    ),
  )

/** After a turn, each lost login not alerted yet runs the command once, off the turn. */
const alertLostLogins = Effect.fn("LoginAlert.afterTurn")(function* () {
  const command = yield* Config.option(Config.NonEmptyString(LOGIN_ALERT_COMMAND)).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  )
  if (Option.isNone(command)) return
  const ctx = yield* ExtensionContext
  const alerts = yield* LoginAlerts
  for (const loss of yield* alerts.fresh(yield* ctx.Accounts.lanes)) {
    yield* alerts.spawn(runAlert(command.value, loss.text))
  }
})

export const LoginAlertExtension = defineExtension({
  id: LOGIN_ALERT_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", LoginAlertsResource)
    yield* host.on("turnAfter", () =>
      alertLostLogins().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("login-alert.check.failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
    )
  }),
})
