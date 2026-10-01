import { describe, expect, test } from "bun:test"
import * as RuntimePublicSdk from "../src/index"

describe("SDK public surface", () => {
  test("exports only stable runtime values", () => {
    expect(Object.keys(RuntimePublicSdk).sort()).toEqual([
      "Gent",
      "ServerLockEntry",
      "ServerLockStatus",
      "buildLogPaths",
      "classifyLogFile",
      "dataPaths",
      "ensureLogDir",
      "makeJsonFileLogger",
      "serverLock",
    ])
  })

  test("the server lock offers a client status, probe and stop only", () => {
    // Reading, writing, removing and holding the lock is `Gent.server`'s own work.
    expect(Object.keys(RuntimePublicSdk.serverLock).sort()).toEqual(["probe", "status", "stop"])
  })
})
