import { Session, Session as StoredSession } from "../domain/message.js"
import { admitChildSessionDepth, admitChildSessionDepth as admit } from "../runtime/session.js"
// Writers admit depth in their own function; unrelated constructors are not
// session writers. Other fixture identifiers stay undeclared.

// The writer's own function calls the admission first.
export const forkAdmitted = Effect.fn("fork")(function* (parentSessionId) {
  yield* admitChildSessionDepth(parentSessionId).pipe(Effect.provideService(Storage, storage))
  return new Session({ id, parentSessionId, createdAt: now })
})

// The writer calls a same-file function that admits, the `admitParent` shape.
export const makeService = Effect.gen(function* () {
  const admitParent = Effect.fn("admitParent")(function* (input) {
    if (input.continueThread !== true) {
      yield* admitChildSessionDepth(input.parentSessionId)
    }
    return input
  })
  const createSession = Effect.fn("createSession")(function* (input) {
    return yield* once(
      Effect.gen(function* () {
        yield* admitParent(input)
        return new Session({ id, parentSessionId: input.parentSessionId })
      }),
    )
  })
  return { createSession }
})

// A root session names no parent.
export const root = new Session({ id, name, createdAt: now })

// A longer field is not the parent field.
export const hinted = new Session({ id, parentSessionIdHint: hint })

// The imported admission helper keeps its authority under an alias.
export const forkAliasedAdmission = Effect.fn("alias")(function* (parentSessionId) {
  yield* admit(parentSessionId)
  return new Session({ id, parentSessionId })
})

export const forkRenamed = Effect.fn("renamed")(function* (parentSessionId) {
  yield* admit(parentSessionId)
  return new StoredSession({ id, ["parentSessionId"]: parentSessionId })
})

// A local class with the same name is not the domain Session constructor.
export const unrelated = (Session) => new Session({ id, parentSessionId })
