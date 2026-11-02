import { and, eq, isNull, sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { advisoryTransactionLock } from "../db/postgres-locks.js";
import { modelValidationCredentialLeases as leases } from "../db/schema.js";
import type { ControlSessionIdentity } from "../services/runner-control-sessions.js";

export interface ValidationCredentialLeaseStore {
  create(id: string, provider: { id: string; credentialCiphertext: string }): Promise<boolean>;
  bind(id: string, poolId: string, session?: ControlSessionIdentity): Promise<boolean>;
  resolve(id: string, refs: string[], poolId?: string): Promise<{ providerId: string; credentialCiphertext: string } | null>;
  revoke(id: string): Promise<void>;
}

/** Shared across Controllers. No request may create/refill a missing lease.
 * Database time bounds credential retrieval, not an already delivered secret.
 */
export class PostgresValidationCredentialLeaseStore implements ValidationCredentialLeaseStore {
  constructor(private readonly db: ControllerDatabase) {}

  async create(id: string, provider: { id: string; credentialCiphertext: string }): Promise<boolean> {
    return this.db.transaction(async tx => {
      // A global, finite count across all issuers, including unbound candidates.
      await advisoryTransactionLock(tx, "model-validation-credential-leases");
      await tx.delete(leases).where(sql`${leases.expiresAt} <= clock_timestamp()`);
      const [count] = await tx.select({ count: sql<number>`count(*)::integer` }).from(leases);
      if (count!.count >= 64) return false;
      await tx.insert(leases).values({ id, providerId: provider.id, credentialCiphertext: provider.credentialCiphertext });
      return true;
    });
  }

  async bind(id: string, poolId: string, session?: ControlSessionIdentity): Promise<boolean> {
    if (session && session.poolId !== poolId) return false;
    return this.db.transaction(async tx => {
      await advisoryTransactionLock(tx, "traffic-router-bindings");
      // Locking the candidate prevents two issuers binding it differently.
      const [lease] = await tx.select().from(leases).where(and(eq(leases.id, id),
        sql`${leases.expiresAt} > clock_timestamp()`)).for("update");
      if (!lease) return false;
      const allocation = await tx.execute<{ group_id: string; epoch: string }>(sql`
        select p.group_id, coalesce(e.epoch, 0)::text as epoch from runner_pool p
        inner join tenant_group g on g.id = p.group_id
        left join runner_pool_lease_epoch e on e.pool_id = p.id
        where p.id = ${poolId} and not coalesce(e.draining, false)`);
      const current = allocation.rows[0];
      if (!current) return false;
      if (session && !await currentSession(tx, session)) return false;
      const epoch = Number(current.epoch);
      if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
      if (lease.poolId !== null) {
        // Repeated binding is idempotent only for exactly the same authority.
        return lease.poolId === poolId && lease.groupId === current.group_id && lease.allocationEpoch === epoch &&
          lease.runnerId === (session?.runnerId ?? null) && lease.bootId === (session?.bootId ?? null) &&
          lease.controlSessionId === (session?.sessionId ?? null);
      }
      await tx.update(leases).set({ poolId, groupId: current.group_id, allocationEpoch: epoch,
        runnerId: session?.runnerId ?? null, bootId: session?.bootId ?? null, controlSessionId: session?.sessionId ?? null })
        .where(eq(leases.id, id));
      return true;
    });
  }

  async resolve(id: string, refs: string[], poolId?: string): Promise<{ providerId: string; credentialCiphertext: string } | null> {
    if (!refs.length || new Set(refs).size !== 1) return null;
    // Allocation, expiry and session checks occur in the same statement that
    // fetches ciphertext; an earlier successful lookup is not retained authority.
    const [row] = await this.db.select({ providerId: leases.providerId, credentialCiphertext: leases.credentialCiphertext })
      .from(leases).where(and(eq(leases.id, id), sql`${leases.expiresAt} > clock_timestamp()`,
        eq(leases.providerId, refs[0]!),
        poolId === undefined ? isNull(leases.poolId) : and(eq(leases.poolId, poolId), sql`exists (
          select 1 from runner_pool p inner join tenant_group g on g.id = p.group_id
          left join runner_pool_lease_epoch e on e.pool_id = p.id
          where p.id = ${leases.poolId} and p.group_id = ${leases.groupId}
            and coalesce(e.epoch, 0) = ${leases.allocationEpoch} and not coalesce(e.draining, false))`,
          sql`(${leases.controlSessionId} is null or exists (
            select 1 from runner_instance i inner join runner_control_session s on s.id = i.control_session_id
            where i.runner_id = ${leases.runnerId} and i.boot_id = ${leases.bootId}
              and i.pool_id = ${leases.poolId} and i.control_session_id = ${leases.controlSessionId}
              and i.disconnected_at is null and i.status <> 'offline'
              and s.id = ${leases.controlSessionId} and s.runner_id = ${leases.runnerId}
              and s.boot_id = ${leases.bootId} and s.pool_id = ${leases.poolId} and s.disconnected_at is null))`)))
      .limit(1);
    return row ?? null;
  }

  async revoke(id: string): Promise<void> { await this.db.delete(leases).where(eq(leases.id, id)); }
}

type Transaction = Parameters<Parameters<ControllerDatabase["transaction"]>[0]>[0];
async function currentSession(tx: Transaction, session: ControlSessionIdentity): Promise<boolean> {
  const result = await tx.execute(sql`select 1 from runner_instance i
    inner join runner_control_session s on s.id = i.control_session_id
    where i.runner_id = ${session.runnerId} and i.boot_id = ${session.bootId} and i.pool_id = ${session.poolId}
      and i.control_session_id = ${session.sessionId} and i.disconnected_at is null and i.status <> 'offline'
      and s.id = ${session.sessionId} and s.runner_id = ${session.runnerId} and s.boot_id = ${session.bootId}
      and s.pool_id = ${session.poolId} and s.disconnected_at is null`);
  return result.rows.length === 1;
}
