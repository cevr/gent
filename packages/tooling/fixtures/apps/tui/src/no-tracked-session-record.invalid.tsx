// Every `.session()` read below runs inside a scope Solid tracks.
import { createEffect, createMemo, createResource, on, createEffect as observe, on as watch } from "solid-js"
import * as Solid from "solid-js"
declare const client: {
  readonly session: () => { readonly name: string; readonly sessionId: string }
  readonly activeSessionId: () => string
}
declare const sessionClient: typeof client
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

// 9. a callback an array method runs while the scope tracks
createEffect(() => {
  startTracking([1, 2].map(() => client.session().name))
})

// 10. an `on` source in a deps array
createEffect(
  on([() => client.activeSessionId(), () => client.session()], (deps) => startTracking(deps)),
)

// 11. a function called where it is built runs in the scope
createEffect(() => {
  startTracking((() => client.session())())
})

// 12. a createResource source read through a name
const resourceSource = () => client.session().sessionId
createResource(resourceSource, (id) => id)

// 13–15. Imported aliases and namespace members retain tracking semantics.
observe(() => startTracking(client.session()))
export const renamedIdentity = Solid.createMemo(() => client.session().sessionId)
Solid["createEffect"](() => startTracking(client.session()))

// 16. The deps of an imported aliased `on` run tracked.
createEffect(watch(() => client.session(), (session) => startTracking(session)))

// 17. An unrelated lexical binding does not replace the tracked helper.
function actualRead() { return client.session() }
createEffect(() => startTracking(actualRead()))
export function unrelatedScope() {
  const actualRead = () => "independent"
  return actualRead()
}

// 18. A namespace resource tracks its source, not its fetcher.
Solid.createResource(() => client.session(), (session) => session)

// 19. Solid's batch callback runs inside the surrounding tracked scope.
observe(() => Solid.batch(() => startTracking(client.session())))

// 20. Destructuring a function out of an object keeps the source overload.
const { destructuredFetcher } = { destructuredFetcher: (id) => id }
createResource(() => client.session().sessionId, destructuredFetcher)

// 21. A helper declaration is distinct from its same-named parameter.
function parameterRead(parameterRead) { return client.session() }
createEffect(() => startTracking(parameterRead(undefined)))
