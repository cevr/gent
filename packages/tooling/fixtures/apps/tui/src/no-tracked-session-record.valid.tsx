// Reads that want the record, and scopes that track only the identity.
declare const client: {
  readonly session: () => { readonly name: string; readonly sessionId: string }
  readonly activeSessionId: () => string
  readonly sessionIdentity: () => { readonly sessionId: string }
}
declare const transport: { readonly currentSession: () => { readonly sessionId: string } }
declare const emitter: { readonly on: (event: string, fn: () => void) => void }
declare const createEffect: (fn: () => void) => void
declare const on: <A>(deps: () => A, fn: (a: A) => void) => () => void
declare const createResource: (...args: ReadonlyArray<unknown>) => void
declare const untrack: <A>(fn: () => A) => A
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
