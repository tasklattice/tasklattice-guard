import { accessTokenModuleCopy as modules } from "@/access-token-i18n";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { EntitySheet } from "@/components/entity-sheet";
import { ErrorNotice } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import * as api from "@/lib/access-tokens-api";
import { createAccessTokenSchema, readOnlyTokenModules, tokenModules, type TokenModule, type TokenPermissions } from "../../../shared/access-tokens";

const selectClass = "min-h-11 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
export function AccessTokens() {
  const { user } = useAuth();
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const t = (cn: string, en: string) => zh ? cn : en;
  const client = useQueryClient();
  const key = ["account-access-tokens", user?.id];
  const query = useQuery({ queryKey: key, queryFn: api.listAccessTokens });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [days, setDays] = useState<api.CreateAccessToken["expiresInDays"]>(30);
  const [permissions, setPermissions] = useState<TokenPermissions>({});
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
    onSuccess: () => { setRevoking(null); void client.invalidateQueries({ queryKey: key }); toast.success(t("Token 已撤销", "Token revoked")); },
  });
  const date = (value: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const permissionLabel = (access: string) => access === "write" ? t("读写", "Read and write") : t("只读", "Read only");
  const selected = Object.entries(permissions).filter(([, access]) => access);
  return <div className="max-w-5xl space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl"><h2 className="text-lg font-semibold">{t("个人 Access Tokens", "Personal access tokens")}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("让脚本或集成以你的身份调用系统。每个 Token 仅能访问你授权的模块，且不会超过你当前的账户权限。", "Let scripts and integrations call the system as you. Each token is limited to its selected modules and your current account permissions.")}</p>
      </div>
      <Button variant="create" className="min-h-11" onClick={() => { opener.current = document.activeElement as HTMLElement; setName(""); setDays(30); setPermissions({}); create.reset(); setCreating(true); }}><Plus />{t("创建 Token", "Create token")}</Button>
    </div>
    {query.isPending && <p role="status">{t("正在加载 Tokens…", "Loading tokens…")}</p>}
    {query.error && <div className="space-y-3"><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()}>{t("重试", "Retry")}</Button></div>}
    {query.data && <div className="overflow-hidden rounded-xl border bg-card">
      {!query.data.items.length ? <div className="px-6 py-12 text-center"><KeyRound className="mx-auto mb-3 size-6 text-muted-foreground" /><h3 className="font-medium">{t("尚无 Access Token", "No access tokens yet")}</h3><p className="mt-2 text-sm text-muted-foreground">{t("为每个集成创建独立的 Token，仅选择它需要的权限。", "Create a separate token for each integration and select only the permissions it needs.")}</p></div> :
        <ul className="divide-y">{query.data.items.map(token => {
          const expired = Date.parse(token.expiresAt) <= Date.now();
          return <li key={token.id} className="space-y-3 p-4 sm:p-5">
            <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h3 className="break-words font-medium">{token.name}</h3><p className="mt-1 font-mono text-xs text-muted-foreground">{token.prefix}…</p></div>
              {token.revokedAt ? <span className="text-sm text-muted-foreground">{t("已撤销", "Revoked")}</span> : expired ? <span className="text-sm text-muted-foreground">{t("已过期", "Expired")}</span> : <Button variant="outline" className="min-h-11 shrink-0" aria-label={`${t("撤销", "Revoke")} ${token.name}`} onClick={() => { opener.current = document.activeElement as HTMLElement; revoke.reset(); setRevoking(token); }}><Trash2 />{t("撤销", "Revoke")}</Button>}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">{Object.entries(token.permissions).filter(([,access]) => access).map(([module, access]) => <span key={module}>{modules[module as TokenModule][zh ? 0 : 1]} <span className="text-muted-foreground">· {permissionLabel(access!)}</span></span>)}</div>
            <p className="text-xs leading-5 text-muted-foreground">{t("范围：所选模块中的全部资源", "Scope: all resources in selected modules")}</p>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <div><dt className="inline">{t("创建于：", "Created: ")}</dt><dd className="inline">{date(token.createdAt)}</dd></div>
              <div><dt className="inline">{t("到期：", "Expires: ")}</dt><dd className="inline">{date(token.expiresAt)}</dd></div>
              <div><dt className="inline">{t("最近使用：", "Last used: ")}</dt><dd className="inline">{token.lastUsedAt ? date(token.lastUsedAt) : t("从未", "Never")}</dd></div>
            </dl>
          </li>;
        })}</ul>}
    </div>}
    <div className="space-y-2 text-sm"><h3 className="font-medium">{t("调用方式", "Use a token")}</h3><p className="text-muted-foreground">{t("通过 Authorization: Bearer 请求头传入 Token。以下接口返回身份和 Token 授权范围。", "Send the token in the Authorization: Bearer header. This endpoint returns your identity and token permissions.")}</p><pre className="overflow-x-auto rounded-lg border bg-muted/30 p-4 text-xs leading-6"><code>{`curl '${window.location.origin}/api/v1/account/identity' \\\n  -H "Authorization: Bearer $GUARD_ACCESS_TOKEN"`}</code></pre></div>
    {creating && <EntitySheet open width="lg" returnFocusRef={opener} eyebrow="Account" title={t("创建 Access Token", "Create access token")}
      description={t("绑定当前账户，选择有效期和模块权限。未选择的模块无法访问。", "Bind a token to your account, choose an expiration and grant module permissions. Unselected modules are inaccessible.")}
      closeDisabled={create.isPending} onOpenChange={open => { if (!open && !create.isPending) setCreating(false); }}
      footer={<><Button variant="outline" disabled={create.isPending} onClick={() => setCreating(false)}>{t("取消", "Cancel")}</Button><Button form="create-access-token" type="submit" disabled={!name.trim() || !selected.length || create.isPending}>{create.isPending ? t("正在创建…", "Creating…") : t("创建 Token", "Create token")}</Button></>}>
      <form id="create-access-token" className="space-y-6" onSubmit={event => { event.preventDefault(); if (name.trim() && selected.length && !create.isPending) create.mutate(); }}>
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]"><div className="space-y-2"><Label htmlFor="token-name">{t("名称", "Name")}</Label><Input id="token-name" autoFocus required maxLength={100} value={name} disabled={create.isPending} onChange={event => setName(event.target.value)} placeholder={t("例如：CI 发布", "e.g. CI deployment")} /></div>
          <div className="flex flex-col gap-2"><Label htmlFor="token-expiration">{t("有效期", "Expiration")}</Label><select className={selectClass} id="token-expiration" value={days} disabled={create.isPending} onChange={event => setDays(Number(event.target.value) as typeof days)}>{[7,30,90,365].map(day => <option key={day} value={day}>{day}{t(" 天", " days")}</option>)}</select></div></div>
        <div><h3 className="font-medium">{t("模块权限", "Module permissions")}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("范围覆盖所选模块的全部资源，包括未来新增资源。读写包括创建、修改、发布和删除。", "Access covers all resources in each selected module, including future resources. Read and write includes creation, changes, publication and deletion.")}</p>
          {user?.role !== "admin" && <p className="mt-2 text-sm text-muted-foreground">{t("当前账户只能授予只读权限。", "Your account can grant read-only access.")}</p>}
        </div>
        <div className="divide-y rounded-lg border bg-card px-4">{tokenModules.map(module => <div key={module} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><Label htmlFor={`token-${module}`}>{modules[module][zh ? 0 : 1]}</Label><p className="mt-1 text-xs leading-5 text-muted-foreground">{modules[module][zh ? 2 : 3]}</p></div><select id={`token-${module}`} className={`${selectClass} shrink-0 sm:w-40`} value={permissions[module] ?? "none"} disabled={create.isPending} onChange={event => { const next = { ...permissions }; if (event.target.value === "none") delete next[module]; else next[module] = event.target.value as "read" | "write"; setPermissions(next); }}><option value="none">{t("无权限", "No access")}</option><option value="read">{t("只读", "Read only")}</option>{user?.role === "admin" && !readOnlyTokenModules.includes(module) && <option value="write">{t("读写", "Read and write")}</option>}</select></div>)}</div>
        <p className="text-sm text-muted-foreground">{selected.length ? t("已选择 {count} 个模块。Token 明文仅在创建后展示一次。", "Selected modules: {count}. The token will be shown only once after creation.").replace("{count}", String(selected.length)) : t("至少选择一个模块权限。", "Select at least one module permission.")}</p>
        {create.error && <ErrorNotice error={create.error} />}
      </form>
    </EntitySheet>}
    {issued && <EntitySheet open width="md" returnFocusRef={opener} eyebrow="Account" title={t("Token 已创建", "Token created")} description={t("现在复制并妥善保存。关闭后将无法再次查看完整 Token。", "Copy and store it now. You cannot view the full token again after closing.")} onOpenChange={open => { if (!open) setIssued(null); }} footer={<Button onClick={() => setIssued(null)}>{t("完成", "Done")}</Button>}>
      <div className="space-y-4"><p className="font-medium">{issued.name}</p><Label htmlFor="issued-token">Access Token</Label><Input id="issued-token" readOnly value={issued.secret} className="font-mono text-xs" /><Button variant="outline" className="min-h-11" onClick={() => { void navigator.clipboard.writeText(issued.secret).then(() => toast.success(t("已复制 Token", "Token copied")), () => toast.error(t("复制失败，请手动选中并复制。", "Copy failed. Select and copy the token manually."))); }}><Copy />{t("复制 Token", "Copy token")}</Button></div>
    </EntitySheet>}
    {revoking && <EntitySheet open width="md" returnFocusRef={opener} eyebrow="Account" title={t("撤销 {name}？", "Revoke {name}?").replace("{name}", revoking.name)} description={t("撤销后，使用此 Token 的后续请求将被拒绝。此操作不可撤回，需要时可创建新的 Token。", "Subsequent requests using this token will be rejected. This cannot be undone; create a new token if needed.")} closeDisabled={revoke.isPending} onOpenChange={open => { if (!open && !revoke.isPending) setRevoking(null); }} footer={<><Button variant="outline" disabled={revoke.isPending} onClick={() => setRevoking(null)}>{t("取消", "Cancel")}</Button><Button variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>{revoke.isPending ? t("正在撤销…", "Revoking…") : t("撤销 Token", "Revoke token")}</Button></>}>{revoke.error && <ErrorNotice error={revoke.error} />}</EntitySheet>}
  </div>;
}
