import { test } from "bun:test"

test("manual cleanup is banned", async () => {
  try {
    return await work()
  } finally {
    cleanup()
  }
})

test("promise chains are banned", () => work().then((value) => value))

test("promise catch is banned", () => work().catch(() => "fallback"))

test("promise finally is banned", () => work().finally(cleanup))

async function work(): Promise<string> {
  return "work"
}

declare const cleanup: () => void
