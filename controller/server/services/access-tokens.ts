import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { createAccessTokenSchema, type AccessTokenView, type TokenPermissions } from "../../shared/access-tokens.js";
import type { ControllerDatabase } from "../db/client.js";
import { auditEvents, personalAccessTokens, user } from "../db/schema.js";
import { ControllerError, NotFoundError } from "../domain/errors.js";

export type TokenIdentity = { id: string; role: string; tokenId: string; permissions: TokenPermissions };
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
function view(row: typeof personalAccessTokens.$inferSelect): AccessTokenView {
  return { id: row.id, name: row.name, prefix: row.prefix, permissions: row.permissions,
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null };
}
export class AccessTokenService {
  constructor(private readonly db: ControllerDatabase) {}
  async list(userId: string) {
    return (await this.db.select().from(personalAccessTokens).where(eq(personalAccessTokens.userId, userId))
      .orderBy(desc(personalAccessTokens.createdAt))).map(view);
  }
  async create(userId: string, raw: unknown) {
    const input = createAccessTokenSchema.parse(raw);
    const secret = `tlg_pat_${randomBytes(32).toString("base64url")}`;
    const result = await this.db.transaction(async tx => {
      // Lock the owner to serialize issuance and enforce the current role and token limit.
      const [owner] = await tx.select().from(user).where(eq(user.id, userId)).for("update");
      if (!owner || owner.banned) throw new ControllerError("Account is unavailable.", 403, "forbidden");
      if (owner.role !== "admin" && Object.values(input.permissions).includes("write"))
        throw new ControllerError("Only administrators can grant write access.", 403, "forbidden");
      const now = new Date();
      const active = await tx.select({ id: personalAccessTokens.id }).from(personalAccessTokens)
        .where(and(eq(personalAccessTokens.userId, userId), isNull(personalAccessTokens.revokedAt), gt(personalAccessTokens.expiresAt, now)));
      if (active.length >= 50) throw new ControllerError("Revoke an existing token before creating another (limit: 50 active tokens).", 409, "token_limit");
      const values: typeof personalAccessTokens.$inferInsert = { id: randomUUID(), userId, name: input.name,
        prefix: secret.slice(0, 15), tokenHash: digest(secret), permissions: input.permissions,
        expiresAt: new Date(now.getTime() + input.expiresInDays * 86_400_000) };
      const [row] = await tx.insert(personalAccessTokens).values(values).returning();
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "access_token.created", actorId: userId,
        resourceType: "access_token", resourceId: row!.id, detail: { name: input.name, permissions: input.permissions, expiresAt: row!.expiresAt.toISOString() } });
      return view(row!);
    });
    return { token: result, secret };
  }
  async revoke(userId: string, id: string) {
    await this.db.transaction(async tx => {
      const [row] = await tx.select().from(personalAccessTokens)
        .where(and(eq(personalAccessTokens.id, id), eq(personalAccessTokens.userId, userId))).for("update");
      if (!row) throw new NotFoundError("Access token", id);
      if (row.revokedAt) return;
      await tx.update(personalAccessTokens).set({ revokedAt: new Date() }).where(eq(personalAccessTokens.id, id));
      await tx.insert(auditEvents).values({ id: randomUUID(), kind: "access_token.revoked", actorId: userId,
        resourceType: "access_token", resourceId: id, detail: { name: row.name } });
    });
  }
  async authenticate(secret: string): Promise<TokenIdentity | null> {
    if (!/^tlg_pat_[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    const now = new Date();
    const [row] = await this.db.select({ token: personalAccessTokens, owner: user }).from(personalAccessTokens)
      .innerJoin(user, eq(user.id, personalAccessTokens.userId))
      .where(and(eq(personalAccessTokens.tokenHash, digest(secret)), isNull(personalAccessTokens.revokedAt), gt(personalAccessTokens.expiresAt, now), eq(user.banned, false)));
    if (!row) return null;
    // Conditional update also rejects a revocation that raced the lookup.
    const touched = await this.db.update(personalAccessTokens).set({ lastUsedAt: now })
      .where(and(eq(personalAccessTokens.id, row.token.id), isNull(personalAccessTokens.revokedAt), gt(personalAccessTokens.expiresAt, now))).returning({ id: personalAccessTokens.id });
    return touched.length ? { id: row.owner.id, role: row.owner.role, tokenId: row.token.id, permissions: row.token.permissions } : null;
  }
  async recordRequest(actor: TokenIdentity, method: string, route: string, status: number) {
    await this.db.insert(auditEvents).values({ id: randomUUID(), kind: "access_token.request", actorId: actor.id,
      resourceType: "access_token", resourceId: actor.tokenId, detail: { method, route, status } });
  }
}
