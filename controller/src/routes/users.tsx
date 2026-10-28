import { hasPermission } from "../../shared/rbac";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck, UserRoundCog, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import { EntitySheet } from "@/components/entity-sheet";
import { EmptyState, ErrorNotice, PageHeader, StateBadge } from "@/components/product-shell";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import { createUser, getUsers, updateUser, type IdentityRole, type IdentityUser } from "@/lib/identity-api";

export function UsersPage() {
  const { t, i18n } = useTranslation();
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.users, queryFn: getUsers, enabled: hasPermission(currentUser?.role, "users") });
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<IdentityUser | null>(null);

  if (!hasPermission(currentUser?.role, "users")) {
    return (
      <section className="py-6 sm:py-8">
        <EmptyState title={t("users.accessDeniedTitle")} description={t("users.accessDeniedDescription")} />
      </section>
    );
  }

  const users = query.data?.users ?? [];
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.users }); };

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("users.title")}
        description={t("users.description")}
        action={<Button size="lg" className="self-start" onClick={() => setCreateOpen(true)}><Plus />{t("users.add")}</Button>}
      />

      {query.error ? <div className="mt-5"><ErrorNotice error={query.error} /></div> : null}

      {users.length ? (
        <section className="mt-6 overflow-hidden rounded-xl border bg-card">
          <div className="hidden grid-cols-[minmax(260px,1.4fr)_150px_130px_180px_36px] border-b bg-muted/40 px-5 py-3 text-xs font-medium text-muted-foreground md:grid">
            <span>{t("users.user")}</span><span>{t("common.role")}</span><span>{t("common.status")}</span><span>{t("users.lastLogin")}</span><span />
          </div>
          <div className="divide-y divide-border">
            {users.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelected(item)}
                className="grid w-full gap-4 px-5 py-4 text-left transition-colors hover:bg-muted/35 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring md:grid-cols-[minmax(260px,1.4fr)_150px_130px_180px_36px] md:items-center"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar className="size-9"><AvatarFallback>{initials(item.display_name)}</AvatarFallback></Avatar>
                  <span className="min-w-0"><span className="flex items-center gap-2"><strong className="truncate text-sm font-medium">{item.display_name}</strong>{item.id === currentUser?.id ? <Badge variant="secondary" className="text-[10px]">{t("users.currentUser")}</Badge> : null}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.username}</span></span>
                </span>
                <span><Badge variant="outline" className="gap-1.5 font-normal">{item.role === "admin" ? <ShieldCheck className="size-3.5 text-primary" /> : <UsersRound className="size-3.5 text-muted-foreground" />}{t(item.role === "admin" ? "common.admin" : "common.member")}</Badge></span>
                <span><StateBadge state={item.enabled ? "enabled" : "disabled"} /></span>
                <span className="text-xs text-muted-foreground">{item.last_login_at ? formatDate(item.last_login_at, i18n.language) : t("common.never")}</span>
                <UserRoundCog className="size-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        </section>
      ) : !query.isLoading ? <div className="mt-6"><EmptyState title={t("users.emptyTitle")} description={t("users.emptyDescription")} action={<Button onClick={() => setCreateOpen(true)}><Plus />{t("users.add")}</Button>} /></div> : null}

      <CreateUserSheet open={createOpen} onOpenChange={setCreateOpen} onCreated={async () => { setCreateOpen(false); await refresh(); }} />
      <EditUserSheet user={selected} onOpenChange={(open) => { if (!open) setSelected(null); }} onUpdated={async (updated) => { setSelected(updated); await refresh(); }} />
    </section>
  );
}

function CreateUserSheet({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<IdentityRole>("user");
  const [language, setLanguage] = useState<"en" | "zh-CN">("en");
  useEffect(() => { if (open) { setDisplayName(""); setUsername(""); setPassword(""); setRole("user"); setLanguage("en"); } }, [open]);
  const mutation = useMutation({
    mutationFn: () => createUser({ display_name: displayName, username, password, role, preferred_language: language }),
    onSuccess: () => { toast.success(t("users.added")); onCreated(); },
    onError: (error) => toast.error(error instanceof Error ? error.message : t("common.unknownError")),
  });
  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={t("users.eyebrow")}
      title={t("users.createTitle")}
      description={t("users.createDescription")}
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button disabled={!displayName.trim() || !username.trim() || password.length < 8 || mutation.isPending} onClick={() => mutation.mutate()}><Plus />{mutation.isPending ? t("common.creating") : t("common.create")}</Button></>}
    >
      <div className="grid gap-5">
        <Field label={t("auth.displayName")}><Input autoFocus autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
        <Field label={t("auth.username")}><Input type="text" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></Field>
        <Field label={t("common.password")} hint={t("auth.passwordHint")}><Input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("common.role")}><Select value={role} onValueChange={(value) => setRole(value as IdentityRole)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="user">{t("common.member")}</SelectItem><SelectItem value="admin">{t("common.admin")}</SelectItem></SelectContent></Select></Field>
          <Field label={t("common.language")}><Select value={language} onValueChange={(value) => setLanguage(value as typeof language)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="en">{t("common.english")}</SelectItem><SelectItem value="zh-CN">{t("common.chinese")}</SelectItem></SelectContent></Select></Field>
        </div>
      </div>
    </EntitySheet>
  );
}

function EditUserSheet({ user, onOpenChange, onUpdated }: { user: IdentityUser | null; onOpenChange: (open: boolean) => void; onUpdated: (user: IdentityUser) => void }) {
  const { t, i18n } = useTranslation();
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<IdentityRole>("user");
  const [enabled, setEnabled] = useState(true);
  const [password, setPassword] = useState("");
  useEffect(() => { if (user) { setDisplayName(user.display_name); setRole(user.role); setEnabled(user.enabled); setPassword(""); } }, [user]);
  const mutation = useMutation({
    mutationFn: () => updateUser(user!.id, { display_name: displayName, role, enabled, password: password || undefined }),
    onSuccess: (updated) => { toast.success(t("users.updated")); onUpdated(updated); setPassword(""); },
    onError: (error) => toast.error(error instanceof Error ? error.message : t("common.unknownError")),
  });
  if (!user) return null;
  return (
    <EntitySheet
      open
      onOpenChange={onOpenChange}
      eyebrow={`${t("users.user")} / ${user.username}`}
      title={t("users.editTitle")}
      description={t("users.editDescription")}
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button disabled={!displayName.trim() || (password.length > 0 && password.length < 8) || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? t("common.saving") : t("common.save")}</Button></>}
    >
      <div className="grid gap-5">
        <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-4"><Avatar className="size-10"><AvatarFallback>{initials(user.display_name)}</AvatarFallback></Avatar><div className="min-w-0"><p className="truncate text-sm font-medium">{user.display_name}</p><p className="truncate text-xs text-muted-foreground">{user.username}</p></div></div>
        <Field label={t("auth.displayName")}><Input autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
        <Field label={t("common.role")}><Select value={role} onValueChange={(value) => setRole(value as IdentityRole)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="user">{t("common.member")}</SelectItem><SelectItem value="admin">{t("common.admin")}</SelectItem></SelectContent></Select></Field>
        <div className="flex items-start justify-between gap-4 rounded-xl border p-4"><div><p className="text-sm font-medium">{t("users.activeAccount")}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{t("users.activeHint")}</p></div><Switch checked={enabled} onCheckedChange={setEnabled} aria-label={t("users.activeAccount")} /></div>
        <Field label={t("users.newPasswordOptional")} hint={t("users.resetHint")}><Input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
        <dl className="grid gap-2 rounded-xl bg-muted/35 p-4 text-xs"><div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("users.created")}</dt><dd>{formatDate(user.created_at, i18n.language)}</dd></div><div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("users.lastLogin")}</dt><dd>{user.last_login_at ? formatDate(user.last_login_at, i18n.language) : t("common.never")}</dd></div></dl>
      </div>
    </EntitySheet>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid gap-2 text-sm font-medium">{label}{children}{hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}</label>;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "U";
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join("").toUpperCase();
  return `${Array.from(parts[0])[0] ?? ""}${Array.from(parts.at(-1) ?? "")[0] ?? ""}`.toUpperCase();
}

function formatDate(value: string, language: string) {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
