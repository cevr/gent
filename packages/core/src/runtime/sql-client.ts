import { SqliteClient } from "@effect/sql-sqlite-bun"
import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { Config } from "effect"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export type SqlBackend = "sqlite" | "postgres"

export type SqliteConfig = SqliteClient.SqliteClientConfig

export type PostgresConfig = PgClient.PgClientConfig

export const SqliteClientLive = (config: SqliteConfig) => SqliteClient.layer(config)

export const SqliteClientDefaultLive = SqliteClient.layer({ filename: ".gent/cluster.db" })

export const PostgresClientLive = (config: PostgresConfig) => PgClient.layer(config)

export const SqlClientLive = (config: {
  readonly backend: SqlBackend
  readonly sqlite?: SqliteConfig
  readonly postgres?: PostgresConfig
}): Layer.Layer<SqlClient, Config.ConfigError | SqlError> => {
  if (config.backend === "postgres") {
    if (config.postgres === undefined) {
      return Layer.effectServices(Effect.die("SqlClientLive: postgres config required"))
    }
    return PostgresClientLive(config.postgres)
  }

  return config.sqlite === undefined ? SqliteClientDefaultLive : SqliteClientLive(config.sqlite)
}
