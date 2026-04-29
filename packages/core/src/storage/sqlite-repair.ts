import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { StorageError } from "../domain/storage-error.js"

export const repairSqliteForeignKeyOrphans: Effect.Effect<void, StorageError, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM branches WHERE session_id NOT IN (SELECT id FROM sessions)`
        yield* sql`DELETE FROM messages WHERE branch_id NOT IN (SELECT id FROM branches)`
        yield* sql`DELETE FROM messages WHERE session_id NOT IN (SELECT id FROM sessions)`
        yield* sql`DELETE FROM messages WHERE EXISTS (SELECT 1 FROM branches WHERE branches.id = messages.branch_id AND branches.session_id != messages.session_id)`
        yield* sql`DELETE FROM message_chunks WHERE message_id NOT IN (SELECT id FROM messages)`
        yield* sql`DELETE FROM message_chunks WHERE chunk_id NOT IN (SELECT id FROM content_chunks)`
        yield* sql`DELETE FROM content_chunks WHERE id NOT IN (SELECT chunk_id FROM message_chunks)`
        yield* sql`DELETE FROM events WHERE session_id NOT IN (SELECT id FROM sessions)`
        yield* sql`DELETE FROM events WHERE branch_id IS NOT NULL AND branch_id NOT IN (SELECT id FROM branches)`
        yield* sql`DELETE FROM events WHERE branch_id IS NOT NULL AND EXISTS (SELECT 1 FROM branches WHERE branches.id = events.branch_id AND branches.session_id != events.session_id)`
        yield* sql`DELETE FROM actor_inbox WHERE session_id NOT IN (SELECT id FROM sessions)`
        yield* sql`DELETE FROM actor_inbox WHERE branch_id NOT IN (SELECT id FROM branches)`
        yield* sql`DELETE FROM actor_inbox WHERE EXISTS (SELECT 1 FROM branches WHERE branches.id = actor_inbox.branch_id AND branches.session_id != actor_inbox.session_id)`
        yield* sql`DELETE FROM agent_loop_checkpoints WHERE session_id NOT IN (SELECT id FROM sessions)`
        yield* sql`DELETE FROM agent_loop_checkpoints WHERE branch_id NOT IN (SELECT id FROM branches)`
        yield* sql`DELETE FROM agent_loop_checkpoints WHERE EXISTS (SELECT 1 FROM branches WHERE branches.id = agent_loop_checkpoints.branch_id AND branches.session_id != agent_loop_checkpoints.session_id)`
        yield* sql`DELETE FROM interaction_requests WHERE session_id NOT IN (SELECT id FROM sessions)`
        yield* sql`DELETE FROM interaction_requests WHERE branch_id NOT IN (SELECT id FROM branches)`
        yield* sql`DELETE FROM interaction_requests WHERE EXISTS (SELECT 1 FROM branches WHERE branches.id = interaction_requests.branch_id AND branches.session_id != interaction_requests.session_id)`
        yield* sql`UPDATE sessions SET active_branch_id = NULL WHERE active_branch_id IS NOT NULL AND active_branch_id NOT IN (SELECT id FROM branches)`
        yield* sql`UPDATE sessions SET active_branch_id = NULL WHERE active_branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branches WHERE branches.id = sessions.active_branch_id AND branches.session_id = sessions.id)`
        yield* sql`UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id IS NOT NULL AND parent_session_id NOT IN (SELECT id FROM sessions)`
        yield* sql`UPDATE sessions SET parent_branch_id = NULL WHERE parent_session_id IS NULL`
        yield* sql`UPDATE sessions SET parent_branch_id = NULL WHERE parent_branch_id IS NOT NULL AND parent_branch_id NOT IN (SELECT id FROM branches)`
        yield* sql`UPDATE sessions SET parent_branch_id = NULL WHERE parent_branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branches WHERE branches.id = sessions.parent_branch_id AND branches.session_id = sessions.parent_session_id)`
        yield* sql`UPDATE branches SET parent_branch_id = NULL WHERE parent_branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branches AS parent WHERE parent.id = branches.parent_branch_id AND parent.session_id = branches.session_id)`
      }),
    )
  }).pipe(
    Effect.mapError(
      (error) =>
        new StorageError({
          message: "Failed to repair SQLite foreign key orphans",
          cause: error,
        }),
    ),
  )
