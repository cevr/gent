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
  const actorRef: ActorRef<S, E> = Effect.runSync(spawn)

  tuiLog(`[${tag}] init, initial=${initial._tag}`)

  onMount(() => {
    const unsubscribe = actorRef.subscribe((s) => {
      tuiLog(`[${tag}] state: ${s._tag}`)
      setState(() => s)
    })

    onCleanup(() => {
      tuiLog(`[${tag}] cleanup`)
      unsubscribe()
      actorRef.stopSync()
    })
  })

  const send = (event: E) => {
    tuiLog(`[${tag}] send: ${event._tag}`)
    actorRef.sendSync(event)
  }

  return { state, send, actor: () => actorRef }
}
