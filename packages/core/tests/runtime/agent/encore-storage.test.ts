import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { EncoreMessageStorageLive } from "@gent/core/runtime/agent/encore-storage"
import { SqliteStorage } from "@gent/core/storage/sqlite-storage"
import { EncoreMessageStorage } from "effect-encore"
import { Snowflake } from "effect/unstable/cluster"

const layer = Layer.provideMerge(EncoreMessageStorageLive, SqliteStorage.TestWithSql())
const test = it.live.layer(layer)

describe("EncoreMessageStorageLive", () => {
  test("deleteEnvelope removes the request row and all related rows atomically", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const storage = yield* EncoreMessageStorage

      const requestId = Snowflake.Snowflake("100")

      // Request envelope: id == request_id (kind=0).
      yield* sql`
        INSERT INTO cluster_messages
          (id, message_id, shard_id, entity_type, entity_id, kind, tag, payload, request_id, processed)
          VALUES
          (${"100"}, ${"req-100"}, ${"shard-1"}, ${"AgentLoop"}, ${"e1"}, ${0}, ${"Submit"}, ${"{}"}, ${"100"}, ${false})
      `
      // AckChunk for the same request: id != request_id, kind=1.
      yield* sql`
        INSERT INTO cluster_messages
          (id, message_id, shard_id, entity_type, entity_id, kind, tag, request_id, processed)
          VALUES
          (${"101"}, ${"ack-101"}, ${"shard-1"}, ${"AgentLoop"}, ${"e1"}, ${1}, ${null}, ${"100"}, ${false})
      `
      // Reply for request 100.
      yield* sql`
        INSERT INTO cluster_replies
          (id, kind, request_id, payload, sequence, acked)
          VALUES
          (${"500"}, ${0}, ${"100"}, ${"{}"}, ${0}, ${false})
      `
      // Unrelated request that must survive.
      yield* sql`
        INSERT INTO cluster_messages
          (id, message_id, shard_id, entity_type, entity_id, kind, tag, payload, request_id, processed)
          VALUES
          (${"200"}, ${"req-200"}, ${"shard-1"}, ${"AgentLoop"}, ${"e2"}, ${0}, ${"Submit"}, ${"{}"}, ${"200"}, ${false})
      `
      yield* sql`
        INSERT INTO cluster_replies
          (id, kind, request_id, payload, sequence, acked)
          VALUES
          (${"600"}, ${0}, ${"200"}, ${"{}"}, ${0}, ${false})
      `

      yield* storage.deleteEnvelope(requestId)

      const remainingMessages = yield* sql<{
        id: string
      }>`SELECT id FROM cluster_messages ORDER BY id`
      const remainingReplies = yield* sql<{
        id: string
      }>`SELECT id FROM cluster_replies ORDER BY id`

      // Only the unrelated request and reply should remain.
      expect(remainingMessages.map((row) => String(row.id))).toEqual(["200"])
      expect(remainingReplies.map((row) => String(row.id))).toEqual(["600"])
    }))
})
