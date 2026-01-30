import { SqliteClient } from "@effect/sql-sqlite-bun"
import { PgClient } from "@effect/sql-pg"
import type * as SqlClient from "@effect/sql/SqlClient"
import type * as ConfigError from "effect/ConfigError"
import type * as SqlError from "@effect/sql/SqlError"
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
}): Layer.Layer<SqlClient.SqlClient, ConfigError.ConfigError | SqlError.SqlError> => {
  if (config.backend === "postgres") {
    if (config.postgres === undefined) {
      return Layer.die("SqlClientLive: postgres config required")
    }
    return PostgresClientLive(config.postgres)
  }

  return config.sqlite === undefined ? SqliteClientDefaultLive : SqliteClientLive(config.sqlite)
}
