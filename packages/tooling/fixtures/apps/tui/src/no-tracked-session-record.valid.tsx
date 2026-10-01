// Reads that want the record, and scopes that track only the identity.
declare const client: {
  readonly session: () => { readonly name: string; readonly sessionId: string }
  readonly activeSessionId: () => string
  readonly sessionIdentity: () => { readonly sessionId: string }
}
declare const transport: { readonly currentSession: () => { readonly sessionId: string } }
declare const emitter: { readonly on: (event: string, fn: () => void) => void }
declare const createEffect: (fn: () => void) => void
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
