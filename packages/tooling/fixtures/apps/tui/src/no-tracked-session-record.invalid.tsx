// Every `.session()` read below runs inside a scope Solid tracks.
declare const client: {
  readonly session: () => { readonly name: string; readonly sessionId: string }
}
declare const sessionClient: typeof client
declare const createEffect: (fn: () => void) => void
declare const createMemo: <A>(fn: () => A) => () => A
declare const createResource: <A, B>(source: () => A, fetcher: (a: A) => B) => void
declare const on: <A>(deps: () => A, fn: (a: A) => void) => () => void
declare const startTracking: (value: unknown) => void

// 1. the record as an `on` source
createEffect(
  on(
    () => client.session(),
    (session) => startTracking(session),
  ),
)

// 2. a createEffect body
createEffect(() => {
  startTracking(client.session())
})

// 3. a createMemo
export const identity = createMemo(() => sessionClient.session().sessionId)

// 4. deep in a long effect: no line window bounds the scope
createEffect(() => {
  const a = 1
  const b = 2
  const c = 3
  const d = 4
  const e = 5
  const f = 6
  const g = 7
  const h = 8
  const i = 9
  const j = 10
  const k = 11
  const l = 12
  const m = 13
  startTracking([a, b, c, d, e, f, g, h, i, j, k, l, m, client.session().name])
})

// 5. an accessor bound to a name and called in the scope
const read = client.session
createEffect(() => {
  startTracking(read())
})

// 6. a same-file function handed to `on` by name
const track = () => client.session().sessionId
createEffect(on(track, (id) => startTracking(id)))

// 7. a same-file function a tracked scope calls
function currentName(): string {
  return client.session().name
}
createEffect(() => {
  startTracking(currentName())
})

// 8. a createResource source
createResource(
  () => client.session().sessionId,
  (id) => id,
)

// 9. a callback nested in a tracked scope runs while it tracks
createEffect(() => {
  startTracking([1, 2].map(() => client.session().name))
})
