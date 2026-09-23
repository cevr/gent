import { test } from "bun:test"

test("test module promise chains are banned", () =>
  Promise.resolve("x")
    .then((value) => value)
    .catch(() => "fallback")
    .finally(() => undefined))
