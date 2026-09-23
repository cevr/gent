import { Secret } from "@gent/core/src/domain/secret"
import { GentPlatform } from "@gent/core/host"
import { waitFor } from "@gent/core/test-utils"

export const values = [Secret, GentPlatform, waitFor]
