import { Session, Session as StoredSession } from "../domain/message.js"
import { admitChildSessionDepth } from "../runtime/session.js"
// Each writer skips depth admission in its own function. Other identifiers
// stay undeclared: the rule checks syntax, not type correctness.

// 1. A writer whose function never admits.
export const forkUnadmitted = Effect.fn("fork")(function* (parentSessionId) {
  return new Session({ id, parentSessionId, createdAt: now })
})

// 2. A service factory: a sibling admits, the writer's own function does not.
export const makeService = Effect.gen(function* () {
  const admitted = Effect.fn("admitted")(function* (parentSessionId) {
    yield* admitChildSessionDepth(parentSessionId)
  })
  const create = Effect.fn("create")(function* (input) {
    return new Session({ id, parentSessionId: input.parentSessionId })
  })
  return { admitted, create }
})

// 3. A nested arrow inside an admitted function.
export const forkWithArrow = Effect.fn("arrow")(function* (parentSessionId) {
  yield* admitChildSessionDepth(parentSessionId)
  const nested = () => new Session({ parentSessionId, id })
  return nested
})

// 4. A method shorthand inside an admitted function.
export const forkWithMethod = Effect.fn("method")(function* (parentSessionId) {
  yield* admitChildSessionDepth(parentSessionId)
  return {
    nested() {
      return new Session({ parentSessionId, id })
    },
  }
})

// 5. The admission runs after the write.
export const forkLate = Effect.fn("late")(function* (parentSessionId) {
  const session = new Session({ id, parentSessionId })
  yield* admitChildSessionDepth(parentSessionId)
  return session
})

// 6. Renaming the real constructor does not remove the admission requirement.
export const forkRenamed = () => new StoredSession({ id, parentSessionId })

// 7–8. Static string keys name the same parent field.
export const forkStringKey = () => new Session({ id, "parentSessionId": parent })
export const forkComputedKey = () => new Session({ id, ["parentSessionId"]: parent })

// 9. A parameter that shadows the imported helper is not depth admission.
export const forkShadowed = (admitChildSessionDepth) => {
  admitChildSessionDepth(parentSessionId)
  return new Session({ id, parentSessionId })
}
