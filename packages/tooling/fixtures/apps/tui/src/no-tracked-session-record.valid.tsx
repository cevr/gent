// Reads that want the record, and scopes that track only the identity.
import { createEffect, createResource, on, untrack } from "solid-js"
import * as Solid from "solid-js"
declare const client: {
  readonly session: () => { readonly name: string; readonly sessionId: string }
  readonly activeSessionId: () => string
  readonly sessionIdentity: () => { readonly sessionId: string }
}
declare const transport: { readonly currentSession: () => { readonly sessionId: string } }
declare const emitter: { readonly on: (event: string, fn: () => void) => void }
declare const render: (value: unknown) => void

// An emitter's `.on(` is a listener, not Solid's `on`.
emitter.on("change", () => {
  render(client.session())
})

// An event handler wants the record.
export const onSelect = () => {
  render(client.session().name)
}

// A JSX expression displays the record.
export const Title = () => <text>{client.session().name}</text>

// The narrowed identity accessors.
createEffect(() => {
  render([client.activeSessionId(), client.sessionIdentity()])
})

// The transport accessor answers with the identity alone.
createEffect(() => {
  render(transport.currentSession())
})

// A handler an effect builds runs later, outside the scope.
createEffect(() => {
  render({ onSelect: () => client.session().name })
})

// The `on` callback runs untracked: only its deps are tracked.
createEffect(
  on(
    () => client.activeSessionId(),
    () => render(client.session().name),
  ),
)

// A resource fetcher runs untracked: only its source is tracked.
createResource(
  () => client.activeSessionId(),
  () => client.session(),
)
createResource(() => client.session(), { initialValue: undefined })

// `untrack` reads without tracking.
createEffect(() => {
  render([client.activeSessionId(), untrack(() => client.session().name)])
})

// A listener an effect registers runs later, outside the scope.
createEffect(() => {
  emitter.on("change", () => render(client.session()))
})

// A function an effect hands to a scheduler runs later.
createEffect(() => {
  queueMicrotask(() => render(client.session()))
})

// Options objects and their aliases select the untracked fetcher overload.
const options = { initialValue: undefined }
const aliasOptions = options
createResource(() => client.session(), options)
createResource(() => client.session(), aliasOptions)
Solid.createResource(() => client.session(), options)

// A local callback runner named like Solid's primitive is not a tracker.
export const unknownTracker = (createEffect) => createEffect(() => client.session())

// A shadowing parameter does not inherit a session-accessor binding.
const getter = client.session
export const shadowedAccessor = (getter) => createEffect(() => getter())

// The fetcher remains untracked when source/fetcher are named functions.
const source = () => client.activeSessionId()
const fetcher = () => client.session()
Solid.createResource(source, fetcher)

const typedOptions = options as typeof options
Solid.createResource(() => client.session(), typedOptions)
createResource(() => client.session(), undefined)
Solid.createEffect(() => Solid.untrack(() => client.session()))
const Foreign = { createEffect: (fn) => fn() }
Foreign.createEffect(() => client.session())
