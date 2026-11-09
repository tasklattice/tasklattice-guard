import { z } from "zod";
import { eventSeverities, selectedSeverities } from "./security-severity.js";

export const securityEventsQuery = z.object({
  guardrailId: z.string().min(1).max(256),
  window: z.enum(["1h", "24h", "7d", "15d", "30d"]).default("24h"),
  limit: z.coerce.number().pipe(z.union([z.literal(25), z.literal(50)])).default(25),
  until: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  severity: z.string().transform(value => value.split(","))
    .pipe(z.array(z.enum(eventSeverities)).min(1).max(6)).transform(selectedSeverities).optional(),
});
export type SecurityEventsQuery = z.infer<typeof securityEventsQuery>;

/** One finding, with a stable ordinal inside its immutable runtime checkpoint. */
export type SecurityEventRecord = {
  eventId: string;
  findingIndex: number;
  occurredAt: string;
  requestId: string;
  guardrailId: string | null;
  guardrailVersion: string | null;
  routerId: string | null;
  endpointId: string | null;
  direction: "incoming" | "outgoing" | "completion";
  decision: string;
  protocol: string | null;
  action: string | null;
  finding: Record<string, unknown>;
};
export type SecurityEventPage = {
  items: SecurityEventRecord[];
  count: number;
  nextCursor: string | null;
  since: string;
  until: string;
};
