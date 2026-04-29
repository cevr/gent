import { test } from "bun:test"

test("batch12 module promise control flow is banned", async () => {
  try {
    await Promise.resolve()
  } finally {
    await Promise.resolve()
  }
})

test("batch12 module promise chains are banned", () =>
  Promise.resolve("x")
    .then((value) => value)
    .catch(() => "fallback")
    .finally(() => undefined))
