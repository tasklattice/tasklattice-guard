import { sql, type SQL } from "drizzle-orm";
import { endpointTelemetryContexts as context } from "../db/schema.js";
import type { RoutingEvent } from "./traffic-routing.js";

/** Authorization is evaluated within the assignment INSERT, using only the
 * authenticated pool and immutable archived snapshot, never today's owner. */
export function routingEventProjectId(event: RoutingEvent, authenticatedPoolId: string): SQL<string | null> {
  return sql<string | null>`(select ${context.projectId} from ${context}
    where ${context.id} = ${event.allocationContextId ?? null} and ${context.poolId} = ${authenticatedPoolId}
      and ${context.endpointId} = ${event.endpointId} and ${context.routerId} = ${event.routerId}
      and ${context.routerRevision} = ${event.routerRevision}
      and ${event.decisionAt} >= ${context.issuedAt} - interval '5 minutes'
      and ${event.decisionAt} >= clock_timestamp() - interval '30 days'
      and ${event.decisionAt} <= ${event.occurredAt}
      and ${event.occurredAt} <= clock_timestamp() + interval '5 minutes'
      and (${context.retiredAt} is null or ${event.occurredAt} <= ${context.retiredAt} + interval '10 minutes')
      and ((${event.assignmentStatus} = 'assigned' and exists (
        select 1 from jsonb_array_elements(${context.targets}) target
        where target->>'routeId' = ${event.routeId} and target->>'targetId' = ${event.targetId}
          and target->>'guardrailId' = ${event.guardrailId} and target->>'guardrailVersion' = ${event.guardrailVersion}))
        or (${event.assignmentStatus} = 'unassigned' and ${event.targetId} = ''
          and ${event.guardrailId} = '' and ${event.guardrailVersion} = ''
          and (${event.routeId} = '' or exists (select 1 from jsonb_array_elements(${context.targets}) target
            where target->>'routeId' = ${event.routeId})))) limit 1)`;
}
