// Writers that admit the depth in their own function, and rows that are not
// child-session writers. Identifiers are undeclared on purpose: the rule
// reads the syntax only.

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
