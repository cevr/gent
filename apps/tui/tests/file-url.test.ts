import { describe, test, expect } from "bun:test"
import { fileUrl, isAbsPath } from "../src/utils/file-url"

describe("fileUrl", () => {
  test("converts absolute path to file:// URL", () => {
    expect(fileUrl("/Users/cvr/foo.ts")).toBe("file:///Users/cvr/foo.ts")
  })

  test("handles root path", () => {
    expect(fileUrl("/")).toBe("file:///")
  })

  test("handles path with spaces", () => {
    expect(fileUrl("/Users/cvr/my project/foo.ts")).toBe("file:///Users/cvr/my project/foo.ts")
  })
})

describe("isAbsPath", () => {
  test("/foo is absolute", () => {
    expect(isAbsPath("/foo")).toBe(true)
  })

  test("foo is not absolute", () => {
    expect(isAbsPath("foo")).toBe(false)
  })

  test("~/foo is not absolute", () => {
    expect(isAbsPath("~/foo")).toBe(false)
  })

  test("empty string is not absolute", () => {
    expect(isAbsPath("")).toBe(false)
  })

  test("./foo is not absolute", () => {
    expect(isAbsPath("./foo")).toBe(false)
  })
})
