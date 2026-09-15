import { describe, expect, test } from "bun:test"
import { formatDuration } from "../src/utils/format-duration"

describe("formatDuration", () => {
  describe("compact", () => {
    test("whole seconds under a minute", () => {
      expect(formatDuration(0, "compact")).toBe("0s")
      expect(formatDuration(1_000, "compact")).toBe("1s")
      expect(formatDuration(30_000, "compact")).toBe("30s")
      expect(formatDuration(59_999, "compact")).toBe("59s")
    })

    test("minutes and unpadded seconds", () => {
      expect(formatDuration(60_000, "compact")).toBe("1m 0s")
      expect(formatDuration(61_000, "compact")).toBe("1m 1s")
      expect(formatDuration(90_000, "compact")).toBe("1m 30s")
      expect(formatDuration(125_000, "compact")).toBe("2m 5s")
    })

    test("minutes past the hour stay minutes", () => {
      expect(formatDuration(3_600_000, "compact")).toBe("60m 0s")
      expect(formatDuration(3_661_000, "compact")).toBe("61m 1s")
    })
  })

  describe("padded", () => {
    test("whole seconds under a minute", () => {
      expect(formatDuration(0, "padded")).toBe("0s")
      expect(formatDuration(45_500, "padded")).toBe("45s")
    })

    test("minutes and two-digit seconds without a space", () => {
      expect(formatDuration(60_000, "padded")).toBe("1m00s")
      expect(formatDuration(125_000, "padded")).toBe("2m05s")
      expect(formatDuration(754_000, "padded")).toBe("12m34s")
    })
  })

  describe("precise", () => {
    test("milliseconds under a second, tenths under a minute, then minutes and seconds", () => {
      expect(formatDuration(12, "precise")).toBe("12ms")
      expect(formatDuration(999.6, "precise")).toBe("1000ms")
      expect(formatDuration(1_250, "precise")).toBe("1.3s")
      expect(formatDuration(59_940, "precise")).toBe("59.9s")
      expect(formatDuration(65_000, "precise")).toBe("1m 5s")
    })
  })
})
