/**
 * Result type for tracking async operation state
 * Used with Solid signals to track Effect execution status
 */
import type { Cause } from "effect/Cause"

/** Discriminated union for async operation state */
export type Result<A, E = never> =
  | { readonly _tag: "Initial"; readonly waiting: boolean }
  | { readonly _tag: "Success"; readonly value: A; readonly waiting: boolean }
  | { readonly _tag: "Failure"; readonly cause: Cause<E>; readonly waiting: boolean }

/** Create an Initial result */
export const initial = <A, E>(waiting = false): Result<A, E> => ({
  _tag: "Initial",
  waiting,
})

/** Create a Success result */
export const success = <A, E>(value: A, waiting = false): Result<A, E> => ({
  _tag: "Success",
  value,
  waiting,
})

/** Create a Failure result */
export const failure = <A, E>(cause: Cause<E>, waiting = false): Result<A, E> => ({
  _tag: "Failure",
  cause,
  waiting,
})

/** Pattern match on Result */
export const match = <A, E, R>(
  result: Result<A, E>,
  handlers: {
    onInitial: () => R
    onSuccess: (value: A) => R
    onFailure: (cause: Cause<E>) => R
  },
): R => {
  switch (result._tag) {
    case "Initial":
      return handlers.onInitial()
    case "Success":
      return handlers.onSuccess(result.value)
    case "Failure":
      return handlers.onFailure(result.cause)
  }
}

/** Check if result is Initial */
export const isInitial = <A, E>(
  result: Result<A, E>,
): result is Result<A, E> & { _tag: "Initial" } => result._tag === "Initial"

/** Check if result is Success */
export const isSuccess = <A, E>(
  result: Result<A, E>,
): result is Result<A, E> & { _tag: "Success" } => result._tag === "Success"

/** Check if result is Failure */
export const isFailure = <A, E>(
  result: Result<A, E>,
): result is Result<A, E> & { _tag: "Failure" } => result._tag === "Failure"

/** Get value from Success, or undefined */
export const getOrUndefined = <A, E>(result: Result<A, E>): A | undefined =>
  result._tag === "Success" ? result.value : undefined

/** Get value from Success, or default */
export const getOrElse = <A, E>(result: Result<A, E>, defaultValue: A): A =>
  result._tag === "Success" ? result.value : defaultValue
