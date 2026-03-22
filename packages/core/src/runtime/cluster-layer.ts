import * as HttpRunner from "effect/unstable/cluster/HttpRunner"
import type * as ShardingConfig from "effect/unstable/cluster/ShardingConfig"
import * as SingleRunner from "effect/unstable/cluster/SingleRunner"
import * as TestRunner from "effect/unstable/cluster/TestRunner"

export type ClusterStorage = "sql" | "memory"

export const ClusterMemoryLive = TestRunner.layer

export const ClusterSingleLive = (options?: {
  readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]>
  readonly runnerStorage?: ClusterStorage
}) =>
  SingleRunner.layer({
    shardingConfig: options?.shardingConfig,
    runnerStorage: options?.runnerStorage === "memory" ? "memory" : "sql",
  })

export const ClusterHttpServerLive = HttpRunner.layerHttp

export const ClusterHttpClientLive = HttpRunner.layerClient

export const ClusterHttpClientOnlyLive = HttpRunner.layerHttpClientOnly
