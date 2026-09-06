import type * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Match from "effect/Match"
import * as Option from "effect/Option"

export class InitialResult {
  readonly _tag = "Initial"

  constructor(readonly waiting = false) {}
}

export class SuccessResult<A> {
  readonly _tag = "Success"

  constructor(
    readonly value: A,
    readonly waiting = false,
  ) {}
}

export class FailureResult<E> {
  readonly _tag = "Failure"

  constructor(
    readonly cause: Cause.Cause<E>,
    readonly waiting = false,
  ) {}
}

export type Result<A, E = never> = InitialResult | SuccessResult<A> | FailureResult<E>

export const initial = <A = never, E = never>(waiting = false): Result<A, E> =>
  new InitialResult(waiting)

export const success = <A, E = never>(value: A, waiting = false): Result<A, E> =>
  new SuccessResult(value, waiting)

export const failure = <A = never, E = never>(
  cause: Cause.Cause<E>,
  waiting = false,
): Result<A, E> => new FailureResult(cause, waiting)

export const isInitial = <A, E>(result: Result<A, E>): result is InitialResult =>
  result._tag === "Initial"

export const isSuccess = <A, E>(result: Result<A, E>): result is SuccessResult<A> =>
  result._tag === "Success"

export const isFailure = <A, E>(result: Result<A, E>): result is FailureResult<E> =>
  result._tag === "Failure"

export const fromExit = <A, E>(exit: Exit.Exit<A, E>): Result<A, E> => {
  if (Exit.isSuccess(exit)) return success(exit.value)
  return failure(exit.cause)
}

export const waiting = <A, E>(result: Result<A, E>): Result<A, E> => {
  if (result.waiting) return result
  return Match.value(result).pipe(
    Match.tagsExhaustive({
      Initial: () => initial<A, E>(true),
      Success: (result) => success<A, E>(result.value, true),
      Failure: (result) => failure<A, E>(result.cause, true),
    }),
  )
}

export const waitingFrom = <A, E>(previous: Option.Option<Result<A, E>>): Result<A, E> => {
  if (Option.isSome(previous)) return waiting(previous.value)
  return initial(true)
}

export const match = <A, E, R>(
  result: Result<A, E>,
  handlers: {
    onInitial: () => R
    onSuccess: (value: A) => R
    onFailure: (cause: Cause.Cause<E>) => R
  },
): R => {
  // eslint-disable-next-line effect/preferMatchTagsExhaustive -- Match returns Unify<R>, which cannot preserve this caller-owned generic return type.
  switch (result._tag) {
    case "Initial":
      return handlers.onInitial()
    case "Success":
      return handlers.onSuccess(result.value)
    case "Failure":
      return handlers.onFailure(result.cause)
  }
}

// eslint-disable-next-line effect/noNullish -- Solid accessors use undefined to omit absent JSX content.
export const getOrUndefined = <A, E>(result: Result<A, E>): A | undefined => {
  if (result._tag === "Success") return result.value
  // eslint-disable-next-line effect/noNullish -- Preserve the Solid accessor absence contract.
  return undefined
}

export const getOrElse = <A, E>(result: Result<A, E>, defaultValue: A): A => {
  if (result._tag === "Success") return result.value
  return defaultValue
}
