import { describe, test, expect } from "bun:test"
import { Cause } from "effect"
import {
  initial,
  success,
  failure,
  match,
  isInitial,
  isSuccess,
  isFailure,
  getOrUndefined,
  getOrElse,
} from "@gent/core/domain/result"

describe("Result", () => {
  describe("constructors", () => {
    test("initial", () => {
      const r = initial()
      expect(r._tag).toBe("Initial")
      expect(r.waiting).toBe(false)
    })

    test("initial with waiting", () => {
      const r = initial(true)
      expect(r.waiting).toBe(true)
    })

    test("success", () => {
      const r = success(42)
      expect(r._tag).toBe("Success")
      expect(r.value).toBe(42)
      expect(r.waiting).toBe(false)
    })

    test("success with waiting", () => {
      const r = success("ok", true)
      expect(r.waiting).toBe(true)
    })

    test("failure", () => {
      const cause = Cause.fail("boom")
      const r = failure(cause)
      expect(r._tag).toBe("Failure")
      expect(r.cause).toBe(cause)
      expect(r.waiting).toBe(false)
    })
  })

  describe("guards", () => {
    test("isInitial", () => {
      expect(isInitial(initial())).toBe(true)
      expect(isInitial(success(1))).toBe(false)
      expect(isInitial(failure(Cause.fail("x")))).toBe(false)
    })

    test("isSuccess", () => {
      expect(isSuccess(success(1))).toBe(true)
      expect(isSuccess(initial())).toBe(false)
    })

    test("isFailure", () => {
      expect(isFailure(failure(Cause.fail("x")))).toBe(true)
      expect(isFailure(success(1))).toBe(false)
    })
  })

  describe("match", () => {
    test("dispatches to correct handler", () => {
      const onInitial = () => "init"
      const onSuccess = (v: number) => `ok:${v}`
      const onFailure = () => "err"
      const handlers = { onInitial, onSuccess, onFailure }

      expect(match(initial<number, string>(), handlers)).toBe("init")
      expect(match(success<number, string>(42), handlers)).toBe("ok:42")
      expect(match(failure<number, string>(Cause.fail("x")), handlers)).toBe("err")
    })
  })

  describe("getters", () => {
    test("getOrUndefined returns value on success", () => {
      expect(getOrUndefined(success(42))).toBe(42)
    })

    test("getOrUndefined returns undefined on initial/failure", () => {
      expect(getOrUndefined(initial())).toBeUndefined()
      expect(getOrUndefined(failure(Cause.fail("x")))).toBeUndefined()
    })

    test("getOrElse returns value on success", () => {
      expect(getOrElse(success(42), 0)).toBe(42)
    })

    test("getOrElse returns default on initial/failure", () => {
      expect(getOrElse(initial(), 0)).toBe(0)
      expect(getOrElse(failure(Cause.fail("x")), 0)).toBe(0)
    })
  })
})
