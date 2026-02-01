/**
 * Solid integration for effect-machine
 *
 * Spawns an actor, subscribes state changes to a Solid signal,
 * and provides a sync `send` function for event dispatch.
 */

import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { Effect } from "effect"
import { type ActorRef } from "effect-machine"
import { tuiLog } from "../utils/unified-tracer"

interface UseMachineReturn<
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
> {
  state: Accessor<S>
  send: (event: E) => void
  actor: () => ActorRef<S, E> | undefined
}

/**
 * Spawn an effect-machine actor and bind it to Solid reactivity.
 *
 * Takes a pre-bound spawn effect (from Machine.spawn) to preserve types.
 * Actor lifecycle tied to component mount/cleanup via actor.stop.
 *
 * @example
 * const { state, send } = useMachine(
 *   Machine.spawn(authMachine),
 *   AuthState.List({ ... }),
 * )
 */
export function useMachine<
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
>(
  spawn: Effect.Effect<ActorRef<S, E>>,
  initial: NoInfer<S>,
  label?: string,
): UseMachineReturn<S, E> {
  const tag = label ?? "machine"
  const [state, setState] = createSignal<S>(initial)
  let actorRef: ActorRef<S, E> | undefined = undefined
  const pending: E[] = []

  tuiLog(`[${tag}] init, initial=${initial._tag}`)

  onMount(() => {
    tuiLog(`[${tag}] onMount`)
    actorRef = Effect.runSync(spawn.pipe(Effect.orDie))
    tuiLog(`[${tag}] spawned, flushing ${pending.length} pending events`)

    for (const event of pending) {
      tuiLog(`[${tag}] flush: ${event._tag}`)
      Effect.runFork(actorRef.send(event))
    }
    pending.length = 0

    const unsubscribe = actorRef.subscribe((s) => {
      tuiLog(`[${tag}] state: ${s._tag}`)
      setState(() => s)
    })

    onCleanup(() => {
      tuiLog(`[${tag}] cleanup`)
      unsubscribe()
      if (actorRef !== undefined) Effect.runFork(actorRef.stop)
    })
  })

  const send = (event: E) => {
    if (actorRef === undefined) {
      tuiLog(`[${tag}] send (queued, no actor): ${event._tag}`)
      pending.push(event)
      return
    }
    tuiLog(`[${tag}] send: ${event._tag}`)
    Effect.runFork(actorRef.send(event))
  }

  return { state, send, actor: () => actorRef }
}
