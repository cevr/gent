import * as HttpRunner from "@effect/cluster/HttpRunner"
import type * as ShardingConfig from "@effect/cluster/ShardingConfig"
import * as SingleRunner from "@effect/cluster/SingleRunner"
import * as TestRunner from "@effect/cluster/TestRunner"

export type ClusterStorage = "sql" | "memory"

export const ClusterMemoryLive = TestRunner.layer

export const ClusterSingleLive = (options?: {
  readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Type"]>
  readonly runnerStorage?: ClusterStorage
}) =>
  SingleRunner.layer({
    shardingConfig: options?.shardingConfig,
    runnerStorage: options?.runnerStorage === "memory" ? "memory" : "sql",
  })

export const ClusterHttpServerLive = HttpRunner.layerHttp

export const ClusterHttpClientLive = HttpRunner.layerClient

export const ClusterHttpClientOnlyLive = HttpRunner.layerHttpClientOnly
