import { test } from "bun:test"

test("manual cleanup is banned", async () => {
  try {
    return await work()
  } finally {
    cleanup()
  }
})

async function work(): Promise<string> {
  return "work"
}

declare const cleanup: () => void
