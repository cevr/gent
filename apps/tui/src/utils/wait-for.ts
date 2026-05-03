import { Clock, Effect, Schema } from "effect"

export class WaitForTimeout extends Schema.TaggedErrorClass<WaitForTimeout>()("WaitForTimeout", {
  label: Schema.String,
}) {
  override get message(): string {
    return `timed out waiting for ${this.label}`
  }
}

/**
 * Poll a synchronous probe until it returns a defined value or the deadline
 * elapses. Production-side equivalent of the test-utils `waitFor` helper.
 * Suitable for DOM-shaped retries (frame N may not have rendered the element
 * yet; frame N+1 will) where there is no event signal to subscribe to.
 */
export const waitFor = <A>(
  probe: () => A | undefined,
  options: { label: string; intervalMs?: number; timeoutMs?: number },
): Effect.Effect<A, WaitForTimeout> =>
  Effect.gen(function* () {
    const interval = options.intervalMs ?? 30
    const deadline = (yield* Clock.currentTimeMillis) + (options.timeoutMs ?? 500)
    const loop: Effect.Effect<A, WaitForTimeout> = Effect.gen(function* () {
      const value = probe()
      if (value !== undefined) return value
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* new WaitForTimeout({ label: options.label })
      }
      yield* Effect.sleep(`${interval} millis`)
      return yield* loop
    })
    return yield* loop
  })
