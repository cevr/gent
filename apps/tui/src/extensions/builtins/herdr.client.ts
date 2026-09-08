/** Herdr lifecycle integration. Inactive outside an identified Herdr pane. */
import { createEffect, createRoot } from "solid-js"
import { Effect, Option } from "effect"
import { defineClientExtension, clientContributions } from "../client-facets"
import { ClientActivity } from "../client-activity"
import { ClientLifecycle } from "../client-services"
import { herdrEnvironment, makeHerdrReporter } from "../herdr/reporter"

export default defineClientExtension("@gent/herdr", {
  setup: Effect.gen(function* () {
    const target = yield* herdrEnvironment.pipe(Effect.orDie)
    if (Option.isNone(target)) return clientContributions()
    const activity = yield* ClientActivity
    if (Option.isNone(activity.snapshot)) return clientContributions()
    const read = activity.snapshot.value
    const lifecycle = yield* ClientLifecycle
    const reporter = yield* lifecycle.scoped(makeHerdrReporter(target.value))
    createRoot((dispose) => {
      createEffect(() => reporter.report(read()))
      lifecycle.addCleanup(dispose)
    })
    return clientContributions()
  }),
})
