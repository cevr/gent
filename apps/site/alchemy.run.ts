/**
 * gent.cvr.im on Railway, declared as an Alchemy stack. Run it from this
 * directory: `bun run plan`, `bun run deploy` (both `--stage prod`).
 *
 * - Every stage gets its own Railway project and service (`src/deploy.ts`).
 * - `prod` also owns the hostname: the `gent.cvr.im` Railway custom domain,
 *   and in the `cvr.im` Cloudflare zone the two records Railway asks for, a
 *   DNS-only CNAME to the domain's edge host and the `_railway-verify` TXT
 *   record. The zone is adopted and retained: the stack never changes or
 *   deletes it, and records it does not declare are left alone.
 * - Prod adopts what it finds under its own names (the `gent` project, the
 *   `site` service, the domain, the two records), so a deploy after lost
 *   local state takes them back instead of failing or making copies.
 * - The records are DNS-only (`proxied: false`). Railway terminates TLS and
 *   issues the Let's Encrypt certificate itself, which needs the hostname to
 *   resolve to Railway's edge.
 * - Any other stage (`agent-*`, `test_$USER`) is a throwaway with a generated
 *   `*.up.railway.app` URL and no domain or DNS record.
 */
import { Query } from "@distilled.cloud/core/query"
import { Railway } from "@distilled.cloud/railway"
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import { CustomDomain } from "alchemy/Railway/CustomDomain"
import { providers as railwayProviders } from "alchemy/Railway/Providers"
import { Array as Arr, Effect, Layer, Option } from "effect"
import Server, { adoptInProd, GentProject, PORT } from "./src/deploy"

const ZONE = "cvr.im"
const DOMAIN = `gent.${ZONE}`
const VERIFY_PREFIX = "railway-verify="

/** The records Railway lists for one custom domain. */
const dnsRecords = Query.fn((id: string, projectId: string) =>
  Railway.customDomain({ id, projectId }).status.dnsRecords.pipe(
    Query.map((record) => ({
      recordType: record.recordType,
      purpose: record.purpose,
      requiredValue: record.requiredValue,
    })),
  ),
)

/**
 * The CNAME target Railway requires for the domain. A domain without one is a
 * Railway change this stack does not understand, so the plan stops.
 */
const trafficTarget = (customDomainId: string, projectId: string) =>
  dnsRecords(customDomainId, projectId).pipe(
    Effect.map((records) =>
      Arr.findFirst(
        records,
        (record) =>
          record.purpose === "DNS_RECORD_PURPOSE_TRAFFIC_ROUTE" &&
          record.recordType === "DNS_RECORD_TYPE_CNAME" &&
          record.requiredValue.length > 0,
      ),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error(`Railway lists no CNAME target for ${DOMAIN}`)),
        onSome: (route) => Effect.succeed(route.requiredValue),
      }),
    ),
    Effect.orDie,
  )

/**
 * The TXT value Railway checks: `railway-verify=<token>`, whether Railway
 * hands the token with its prefix or without it.
 */
const verifyValue = (token: Option.Option<string>) =>
  token.pipe(
    Option.map((value) => value.replace(/^railway-verify=/, "")),
    Option.filter((value) => value.length > 0),
    Option.map((value) => `${VERIFY_PREFIX}${value}`),
    Option.match({
      onNone: () => Effect.die(new Error(`Railway lists no verification token for ${DOMAIN}`)),
      onSome: Effect.succeed,
    }),
  )

/** The deployed site service, as the stack yields it. */
type DeployedSite = Effect.Success<typeof Server>

/** `gent.cvr.im`: the Railway custom domain and its two Cloudflare records. */
const Hostname = Effect.fn("Site.hostname")(function* (service: DeployedSite) {
  const zone = yield* Cloudflare.Zone.Zone("Zone", { name: ZONE }).pipe(
    Alchemy.RemovalPolicy.retain(),
  )
  const domain = yield* CustomDomain("Domain", {
    service,
    environment: GentProject,
    domain: DOMAIN,
    targetPort: PORT,
  })
  yield* Cloudflare.DNS.Record("Cname", {
    zoneId: zone.zoneId,
    name: DOMAIN,
    type: "CNAME",
    content: Output.all(domain.customDomainId, domain.projectId).pipe(
      Output.mapEffect(([customDomainId, projectId]) => trafficTarget(customDomainId, projectId)),
    ),
    proxied: false,
    comment: "Railway custom domain (alchemy: gent apps/site)",
  })
  yield* Cloudflare.DNS.Record("Verify", {
    zoneId: zone.zoneId,
    name: `_railway-verify.${DOMAIN}`,
    type: "TXT",
    content: domain.verificationToken.pipe(
      Output.mapEffect((token) => verifyValue(Option.fromUndefinedOr(token))),
    ),
    comment: "Railway domain verification (alchemy: gent apps/site)",
  })
  return domain
}, Alchemy.AdoptPolicy.adopt(true))

/** The stack's providers. */
export const providers = Cloudflare.providers().pipe(Layer.provideMerge(railwayProviders()))

export default Alchemy.Stack(
  "gent-site",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack
    yield* GentProject
    const service = yield* Server.pipe(adoptInProd)
    if (stage !== "prod") return { url: service.url, serviceId: service.serviceId }
    const domain = yield* Hostname(service)
    return {
      url: domain.url,
      serviceId: service.serviceId,
      deploymentStatus: service.deploymentStatus,
      certificateStatus: domain.certificateStatus,
    }
  }),
)
