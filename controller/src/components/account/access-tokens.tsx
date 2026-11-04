import { NativeSelect as CarbonNativeSelect } from "@/components/ui/native-select";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";
import { EntitySheet } from "@/components/entity-sheet";
import { ErrorNotice } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import * as api from "@/lib/access-tokens-api";
import { createAccessTokenSchema, accountModuleAccess, effectiveTokenPermissions, tokenModules, type TokenModule, type TokenPermissions } from "../../../shared/access-tokens";

import "./access-tokens.scss";
export function AccessTokens() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const key = ["account-access-tokens", user?.id];
  const query = useQuery({ queryKey: key, queryFn: api.listAccessTokens });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [days, setDays] = useState<api.CreateAccessToken["expiresInDays"]>(30);
  const [permissions, setPermissions] = useState<TokenPermissions>({});
  useEffect(() => { setPermissions(previous => effectiveTokenPermissions(previous, user?.role ?? "")); }, [user?.role]);
  const [issued, setIssued] = useState<{ name: string; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<api.AccessTokenView | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      // Keep the one-time secret out of the React Query mutation cache.
      const result = await api.createAccessToken(createAccessTokenSchema.parse({ name: name.trim(), expiresInDays: days, permissions }));
      setIssued({ name: result.token.name, secret: result.secret });
    },
    onSuccess: () => { setCreating(false); void client.invalidateQueries({ queryKey: key }); },
  });
  const revoke = useMutation({
    mutationFn: () => api.revokeAccessToken(revoking!.id),
    onSuccess: () => { setRevoking(null); void client.invalidateQueries({ queryKey: key }); toast.success(t("accessTokens.revokedToast")); },
  });
  const date = (value: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const permissionLabel = (access: string) => access === "write" ? t("accessTokens.readWrite") : t("accessTokens.readOnly");
  const selected = Object.entries(permissions).filter(([, access]) => access);
  return <div className="max-w-5xl space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl"><h2 className="text-lg font-semibold">{t("accessTokens.title")}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("accessTokens.description")}</p>
      </div>
      <Button variant="create" className="min-h-11" disabled={user?.role === "user" && !user.project_id} onClick={() => { opener.current = document.activeElement as HTMLElement; setName(""); setDays(30); setPermissions({}); create.reset(); setCreating(true); }}><Plus />{t("accessTokens.create")}</Button>
    </div>
    {query.isPending && <p role="status">{t("accessTokens.loading")}</p>}
    {query.error && <div className="space-y-3"><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()}>{t("common.retry")}</Button></div>}
    {query.data && <div className="overflow-hidden border bg-card">
      {!query.data.items.length ? <div className="px-6 py-12 text-center"><KeyRound className="mx-auto mb-3 size-6 text-muted-foreground" /><h3 className="font-medium">{t("accessTokens.emptyTitle")}</h3><p className="mt-2 text-sm text-muted-foreground">{t("accessTokens.emptyDescription")}</p></div> :
        <ul className="divide-y">{query.data.items.map(token => {
          const expired = Date.parse(token.expiresAt) <= Date.now();
          return <li key={token.id} className="space-y-3 p-4 sm:p-5">
            <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h3 className="break-words font-medium">{token.name}</h3><p className="mt-1 font-mono text-xs text-muted-foreground">{token.prefix}…</p></div>
              {token.revokedAt ? <span className="text-sm text-muted-foreground">{t("accessTokens.revoked")}</span> : expired ? <span className="text-sm text-muted-foreground">{t("accessTokens.expired")}</span> : <Button variant="outline" className="min-h-11 shrink-0" aria-label={t("accessTokens.revokeLabel", { name: token.name })} onClick={() => { opener.current = document.activeElement as HTMLElement; revoke.reset(); setRevoking(token); }}><Trash2 />{t("accessTokens.revoke")}</Button>}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">{Object.entries(token.permissions).filter(([,access]) => access).map(([module, access]) => <span key={module}>{t(`accessTokens.modules.${module as TokenModule}.name`)} <span className="text-muted-foreground">· {permissionLabel(access!)}</span></span>)}</div>
            <p className="text-sm">{token.projectId ? t("account.projectLabel", {project: token.projectId}) : t("sidebar.platformIdentity")}</p>
            <p className="text-xs leading-5 text-muted-foreground">{t("accessTokens.scope")}</p>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <div><dt className="inline">{t("accessTokens.createdAt")}</dt><dd className="inline">{date(token.createdAt)}</dd></div>
              <div><dt className="inline">{t("accessTokens.expiresAt")}</dt><dd className="inline">{date(token.expiresAt)}</dd></div>
              <div><dt className="inline">{t("accessTokens.lastUsedAt")}</dt><dd className="inline">{token.lastUsedAt ? date(token.lastUsedAt) : t("common.never")}</dd></div>
            </dl>
          </li>;
        })}</ul>}
    </div>}
    <div className="space-y-2 text-sm"><h3 className="font-medium">{t("accessTokens.usageTitle")}</h3><p className="text-muted-foreground">{t("accessTokens.usageDescription")}</p><pre className="overflow-x-auto border bg-muted/30 p-4 text-xs leading-6"><code>{`curl '${window.location.origin}/api/v1/account/identity' \\\n  -H "Authorization: Bearer $GUARD_ACCESS_TOKEN"`}</code></pre></div>
    {creating && <EntitySheet open width="lg" returnFocusRef={opener} eyebrow={t("account.title")} title={t("accessTokens.createTitle")}
      description={t("accessTokens.createDescription")}
      closeDisabled={create.isPending} onOpenChange={open => { if (!open && !create.isPending) setCreating(false); }}
      footer={<><Button variant="outline" disabled={create.isPending} onClick={() => setCreating(false)}>{t("common.cancel")}</Button><Button form="create-access-token" type="submit" disabled={!name.trim() || !selected.length || create.isPending}>{create.isPending ? t("accessTokens.creating") : t("accessTokens.create")}</Button></>}>
      <form id="create-access-token" className="access-token-form space-y-6" onSubmit={event => { event.preventDefault(); if (name.trim() && selected.length && !create.isPending) create.mutate(); }}>
        <p className="text-sm text-muted-foreground">{user?.role === "user" ? t("accessTokens.fixedProject", {project: user.project_id}) : t("sidebar.platformIdentity")}</p>
        <div className="access-token-identity"><div className="flex flex-col gap-2"><Label htmlFor="token-name">{t("accessTokens.name")}</Label><Input id="token-name" autoFocus required maxLength={100} value={name} disabled={create.isPending} onChange={event => setName(event.target.value)} placeholder={t("accessTokens.namePlaceholder")} /></div>
          <div className="flex flex-col gap-2"><Label htmlFor="token-expiration">{t("accessTokens.expiration")}</Label><CarbonNativeSelect id="token-expiration" value={days} disabled={create.isPending} onChange={event => setDays(Number(event.target.value) as typeof days)}>{[7,30,90,365].map(day => <option key={day} value={day}>{t("accessTokens.days", { count: day })}</option>)}</CarbonNativeSelect></div></div>
        <div><h3 className="font-medium">{t("accessTokens.permissionsTitle")}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("accessTokens.permissionsDescription")}</p>
          {user?.role !== "admin" && <p className="mt-2 text-sm text-muted-foreground">{t("accessTokens.readOnlyHint")}</p>}
        </div>
        <div className="access-token-permissions">{tokenModules.filter(module => accountModuleAccess(user?.role, module)).map(module => <div key={module} className="access-token-permission-row"><div className="min-w-0"><Label htmlFor={`token-${module}`}>{t(`accessTokens.modules.${module}.name`)}</Label><p id={`token-${module}-description`} className="mt-1 text-xs leading-5 text-muted-foreground">{t(`accessTokens.modules.${module}.description`)}</p></div><CarbonNativeSelect id={`token-${module}`} aria-describedby={`token-${module}-description`} value={permissions[module] ?? "none"} disabled={create.isPending} onChange={event => { const next = { ...permissions }; if (event.target.value === "none") delete next[module]; else next[module] = event.target.value as "read" | "write"; setPermissions(next); }}><option value="none">{t("accessTokens.noAccess")}</option><option value="read">{t("accessTokens.readOnly")}</option>{accountModuleAccess(user?.role, module) === "write" && <option value="write">{t("accessTokens.readWrite")}</option>}</CarbonNativeSelect></div>)}</div>
        <p className="text-sm text-muted-foreground">{selected.length ? t("accessTokens.selectedModules", { count: selected.length }) : t("accessTokens.selectPermissionHint")}</p>
        {create.error && <ErrorNotice error={create.error} />}
      </form>
    </EntitySheet>}
    {issued && <EntitySheet open width="md" returnFocusRef={opener} eyebrow={t("account.title")} title={t("accessTokens.issuedTitle")} description={t("accessTokens.issuedDescription")} onOpenChange={open => { if (!open) setIssued(null); }} footer={<Button onClick={() => setIssued(null)}>{t("accessTokens.done")}</Button>}>
      <div className="space-y-4"><p className="font-medium">{issued.name}</p><Label htmlFor="issued-token">{t("accessTokens.tokenLabel")}</Label><Input id="issued-token" readOnly value={issued.secret} className="field:font-mono field:text-xs" /><Button variant="outline" className="min-h-11" onClick={() => { void navigator.clipboard.writeText(issued.secret).then(() => toast.success(t("accessTokens.copied")), () => toast.error(t("accessTokens.copyFailed"))); }}><Copy />{t("accessTokens.copy")}</Button></div>
    </EntitySheet>}
    {revoking && <EntitySheet open width="md" returnFocusRef={opener} eyebrow={t("account.title")} title={t("accessTokens.revokeTitle", { name: revoking.name })} description={t("accessTokens.revokeDescription")} closeDisabled={revoke.isPending} onOpenChange={open => { if (!open && !revoke.isPending) setRevoking(null); }} footer={<><Button variant="outline" disabled={revoke.isPending} onClick={() => setRevoking(null)}>{t("common.cancel")}</Button><Button variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>{revoke.isPending ? t("accessTokens.revoking") : t("accessTokens.revokeToken")}</Button></>}>{revoke.error && <ErrorNotice error={revoke.error} />}</EntitySheet>}
  </div>;
}
