import { SessionId } from "@gent/core/protocol/domain/ids"
import { GentPlatform } from "@gent/core/host"
import { waitFor } from "@gent/core/test-utils"
import { BunGentPlatformLive } from "../../../../packages/core/src/host.ts"
export { EventStore } from "@gent/core/domain/event"
import { useClient } from "../client"
import { useExtensionUI } from "./host.tsx"
export const values = [SessionId, GentPlatform, waitFor, BunGentPlatformLive, useClient, useExtensionUI]
export const loadRuntime = () => import("@gent/core/runtime/session-runtime")
