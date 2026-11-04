import { hasPermission } from "../../shared/rbac";
import { useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Plus, Search, UserRoundCog } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import { EntitySheet } from "@/components/entity-sheet";
import {
  EmptyState,
  ErrorNotice,
  PageHeader,
  StateBadge,
} from "@/components/product-shell";
import { usernameSchema } from "../../shared/username";
import { passwordMeetsPolicy } from "../../shared/password-policy";
import { AccountPasswordField, PasswordPolicyNotice, usePasswordPolicy } from "@/components/account-password-field";
import { DirectorySelect, type DirectorySelection } from "@/components/directory-select";
import { listProjects, setProjectMember } from "@/lib/projects-api";
import type { UserDetail } from "../../shared/identity";
import {
  DirectoryPagination,
  useDirectoryPage,
} from "@/components/directory-pagination";
import "./people-projects.scss";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { queryKeys } from "@/features/query-keys";
import { useAuth } from "@/lib/auth";
import {
  createUser,
  getUser,
  getUsers,
  updateUser,
  type IdentityRole,
  type IdentityUser,
} from "@/lib/identity-api";

export function UsersPage() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const client = useQueryClient();
  const control = useDirectoryPage("users");
  const query = useQuery({
    queryKey: [...queryKeys.users, control.query],
    queryFn: ({ signal }) => getUsers(control.query, signal),
    enabled: hasPermission(currentUser?.role, "users"),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.users });
  if (!hasPermission(currentUser?.role, "users"))
    return (
      <EmptyState
        title={t("users.accessDeniedTitle")}
        description={t("users.accessDeniedDescription")}
      />
    );
  return (
    <section className="people-projects-page">
      <PageHeader
        title={t("users.title")}
        description={t("users.description")}
        action={
          <Button ref={createTrigger} onClick={() => setCreateOpen(true)}>
            <Plus />
            {t("users.add")}
          </Button>
        }
      />
      {query.error && <ErrorNotice error={query.error} />}
      <section className="user-directory" aria-label={t("users.title")}>
        <div className="user-directory-toolbar">
          <label className="directory-search">
            <Search size={16} />
            <Input
              aria-label={t("users.search")}
              placeholder={t("users.search")}
              value={control.search}
              onChange={(e) => control.setSearch(e.target.value)}
            />
          </label>
        </div>
        <div className="user-directory-columns user-directory-heading">
          <span>{t("users.user")}</span>
          <span>{t("users.source")}</span>
          <span>{t("users.projects")}</span>
          <span>{t("common.role")}</span>
          <span>{t("common.status")}</span>
          <span />
        </div>
        <div className="divide-y divide-border">
          {query.data?.items.map((item) => (
            <button
              key={item.id}
              className="user-directory-columns user-directory-row"
              onClick={event => { detailTrigger.current = event.currentTarget; setSelected(item.id); }}
              aria-label={`${t("users.editTitle")} · ${item.username}`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Avatar className="size-8">
                  <AvatarFallback>{initials(item.username)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-medium">
                    {item.username}
                  </strong>
                </span>
                {item.id === currentUser?.id && (
                  <Badge variant="secondary">{t("users.currentUser")}</Badge>
                )}
              </span>
              <span>
                {item.source === "sso" ? "Keycloak" : t("users.local")}
              </span>
              <span>
                {item.role === "admin"
                  ? t("users.platformAccess")
                  : item.projectCount}
              </span>
              <span>
                {t(item.role === "admin" ? "common.admin" : "common.member")}
              </span>
              <span>
                <StateBadge state={item.enabled ? "enabled" : "disabled"} />
              </span>
              <UserRoundCog className="size-4" />
            </button>
          ))}
        </div>
        {query.isPending && (
          <p className="p-6" role="status">
            {t("common.loading")}
          </p>
        )}
        {!query.isPending && !query.error && !query.data?.items.length && (
          <p className="p-6 text-sm text-muted-foreground">
            {t(control.search ? "users.noResults" : "users.emptyTitle")}
          </p>
        )}
        <DirectoryPagination
          control={control}
          count={query.data?.items.length ?? 0}
          nextCursor={query.data?.nextCursor}
          busy={query.isFetching}
        />
      </section>
      {createOpen && <CreateUserSheet
        returnFocusRef={createTrigger}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void refresh();
        }}
      />}
      {selected && (
        <UserDetailPanel
          key={selected}
          id={selected}
          returnFocusRef={detailTrigger}
          onClose={() => setSelected(null)}
          onUpdated={() => {
            setSelected(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
function UserDetailPanel({
  id,
  onClose,
  onUpdated,
  returnFocusRef,
}: {
  id: string;
  onClose: () => void;
  onUpdated: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["user-detail", id],
    queryFn: async ({ signal }) => {
      const detail = await getUser(id, { limit: 100 }, signal);
      // Fetch every assigned project before editing; a partial page must never
      // become the baseline for removing memberships.
      let cursor = detail.projects.nextCursor;
      const assigned = [...detail.projects.items];
      while (cursor) {
        const page = await getUser(id, { limit: 100, cursor }, signal);
        assigned.push(...page.projects.items);
        cursor = page.projects.nextCursor;
      }
      return { ...detail, projects: { items: assigned, nextCursor: null } };
    },
  });
  if (!query.data)
    return (
      <EntitySheet
        returnFocusRef={returnFocusRef}
        footer={null}
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={t("users.editTitle")}
        eyebrow={t("users.user")}
        description=""
      >
        {query.error ? (
          <ErrorNotice error={query.error} />
        ) : (
          <p role="status">{t("common.loading")}</p>
        )}
      </EntitySheet>
    );
  return (
    <EditUserSheet
      returnFocusRef={returnFocusRef}
      detail={query.data}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onUpdated={onUpdated}
    />
  );
}

function useRefreshPeople() {
  const client = useQueryClient();
  return () => Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.users }),
    client.invalidateQueries({ queryKey: ["projects"] }),
    client.invalidateQueries({ queryKey: ["project-members"] }),
    client.invalidateQueries({ queryKey: ["user-detail"] }),
    client.invalidateQueries({ queryKey: ["directory-select"] }),
  ]);
}

function ProjectSelection({ value, onChange, disabled }: {
  value: DirectorySelection[]; onChange: (value: DirectorySelection[]) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  return <section className="grid gap-2">
    <h3 className="text-sm font-medium">{t("users.projects")}</h3>
    <DirectorySelect scope="user-projects" label={t("accountForm.selectProjects")} value={value}
      onChange={onChange} load={listProjects} disabled={disabled} />
    <p className="text-xs text-muted-foreground">{t(value.length ? "accountForm.projectHint" : "accountForm.noProjectsHint")}</p>
  </section>;
}

function CreateUserSheet({ onClose, onCreated, returnFocusRef }: { onClose: () => void; onCreated: () => void; returnFocusRef: React.RefObject<HTMLButtonElement | null> }) {
  const { t } = useTranslation();
  const refresh = useRefreshPeople();
  const policy = usePasswordPolicy();
  const [username, setUsername] = useState("");
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<IdentityRole>("user");
  const [language, setLanguage] = useState<"en" | "zh-CN">("en");
  const [projects, setProjects] = useState<DirectorySelection[]>([]);
  const [created, setCreated] = useState<IdentityUser | null>(null);
  const assigned = useRef(new Set<string>());
  const validUsername = usernameSchema.safeParse(username).success;
  const mutation = useMutation({
    mutationFn: async () => {
      const account = created ?? await createUser({ username, password, role, preferred_language: language });
      setCreated(account);
      setPassword("");
      if (role === "user") for (const project of projects) {
        if (assigned.current.has(project.id)) continue;
        await setProjectMember(project.id, account.id, true);
        assigned.current.add(project.id);
      }
    },
    onSuccess: () => { toast.success(t("users.added")); onCreated(); },
    onSettled: refresh,
  });
  const locked = mutation.isPending || Boolean(created);
  const valid = Boolean(created) || (validUsername && policy.data && passwordMeetsPolicy(password, policy.data));
  return <EntitySheet open width="md" returnFocusRef={returnFocusRef} title={t("users.createTitle")} eyebrow={t("users.eyebrow")}
    description={t("users.createDescription")} closeDisabled={mutation.isPending}
    onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}
    footer={<><Button variant="outline" disabled={mutation.isPending} onClick={onClose}>{t("common.cancel")}</Button>
      <Button type="submit" form="create-user" disabled={!valid || mutation.isPending}>
        {mutation.isPending ? t("common.saving") : created ? t("accountForm.finishAssignment") : t("common.create")}
      </Button></>}>
    <form id="create-user" className="grid gap-5" onSubmit={event => { event.preventDefault(); if (valid && !mutation.isPending) mutation.mutate(); }}>
      {mutation.error && <div className="grid gap-2">
        {created && <p role="status" className="text-sm">{t("accountForm.createdPending")}</p>}
        <ErrorNotice error={mutation.error} />
      </div>}
      <div className="grid gap-2 text-sm">
        <label htmlFor="create-user-username" className="font-medium">{t("auth.username")}</label>
        <Input id="create-user-username" autoFocus autoComplete="off" value={username} disabled={locked} required maxLength={64}
          aria-describedby="create-user-username-hint" aria-invalid={usernameTouched && !validUsername}
          onBlur={() => setUsernameTouched(true)} onChange={event => setUsername(event.target.value)} />
        <span id="create-user-username-hint" className={usernameTouched && !validUsername ? "text-xs text-destructive" : "text-xs font-normal text-muted-foreground"}>
          {t("accountForm.usernameHint")}
        </span>
      </div>
      <PasswordPolicyNotice query={policy} />
      <AccountPasswordField label={t("common.password")} value={password} onChange={setPassword} policy={policy.data} disabled={locked} />
      <div className="people-projects-fields">
        <Field label={t("common.role")}><Select disabled={locked} value={role} onValueChange={value => { setRole(value as IdentityRole); setProjects([]); }}>
          <SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="user">{t("common.member")}</SelectItem><SelectItem value="admin">{t("common.admin")}</SelectItem>
          </SelectContent></Select></Field>
        <Field label={t("common.language")}><Select disabled={locked} value={language} onValueChange={value => setLanguage(value as typeof language)}>
          <SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="en">{t("common.english")}</SelectItem><SelectItem value="zh-CN">{t("common.chinese")}</SelectItem>
          </SelectContent></Select></Field>
      </div>
      {role === "user" ? <ProjectSelection value={projects} onChange={setProjects} disabled={locked} /> : <p className="text-sm text-muted-foreground">{t("accountForm.adminHint")}</p>}
    </form>
  </EntitySheet>;
}

function EditUserSheet({ detail, onOpenChange, onUpdated, returnFocusRef }: {
  detail: UserDetail; onOpenChange: (open: boolean) => void; onUpdated: (user: IdentityUser) => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const user = detail.user;
  const local = detail.source === "local";
  const { t, i18n } = useTranslation();
  const refresh = useRefreshPeople();
  const policy = usePasswordPolicy(local);
  const [role, setRole] = useState(user.role);
  const [enabled, setEnabled] = useState(user.enabled);
  const [password, setPassword] = useState("");
  const [projects, setProjects] = useState(detail.projects.items);
  const savedProjects = useRef(new Set(detail.projects.items.map(project => project.id)));
  const savedAccount = useRef(user);
  const [partial, setPartial] = useState(false);
  const changed = role !== savedAccount.current.role || enabled !== savedAccount.current.enabled || Boolean(password)
    || (local && (projects.length !== savedProjects.current.size || projects.some(project => !savedProjects.current.has(project.id))));
  const valid = !password || Boolean(policy.data && passwordMeetsPolicy(password, policy.data));
  const mutation = useMutation({
    mutationFn: async () => {
      setPartial(false);
      // Track successful steps so a retry does not reissue a password or redo
      // memberships that already saved before a later request failed.
      if (role !== savedAccount.current.role || enabled !== savedAccount.current.enabled || password) {
        savedAccount.current = await updateUser(user.id, {
          ...(enabled !== savedAccount.current.enabled ? { enabled } : {}),
          ...(local && role !== savedAccount.current.role ? { role } : {}),
          ...(local && password ? { password } : {}),
        });
        setPassword("");
        setPartial(true);
      }
      if (local) {
        const desired = new Set(projects.map(project => project.id));
        for (const id of [...savedProjects.current]) if (!desired.has(id)) {
          await setProjectMember(id, user.id, false);
          savedProjects.current.delete(id);
          setPartial(true);
        }
        for (const id of desired) if (!savedProjects.current.has(id)) {
          await setProjectMember(id, user.id, true);
          savedProjects.current.add(id);
          setPartial(true);
        }
      }
      return savedAccount.current;
    },
    onSuccess: updated => { toast.success(t("users.updated")); onUpdated(updated); },
    onError: () => setPartial(true),
    onSettled: refresh,
  });
  return <EntitySheet open width="md" returnFocusRef={returnFocusRef} title={t("users.editTitle")} eyebrow={`${t("users.user")} / ${user.username}`}
    description={t("users.editDescription")} closeDisabled={mutation.isPending}
    onOpenChange={open => { if (!mutation.isPending) onOpenChange(open); }}
    footer={<><Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
      <Button type="submit" form="edit-user" disabled={!changed || !valid || mutation.isPending}>{mutation.isPending ? t("common.saving") : t("common.save")}</Button></>}>
    <form id="edit-user" className="grid gap-5" onSubmit={event => { event.preventDefault(); if (changed && valid && !mutation.isPending) mutation.mutate(); }}>
      {mutation.error && <div className="grid gap-2">{partial && <p role="status" className="text-sm">{t("accountForm.partialSave")}</p>}<ErrorNotice error={mutation.error} /></div>}
      <Field label={t("common.role")}><Select disabled={!local || mutation.isPending} value={role} onValueChange={value => { setRole(value as IdentityRole); if (value === "admin") setProjects([]); }}>
        <SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="user">{t("common.member")}</SelectItem><SelectItem value="admin">{t("common.admin")}</SelectItem>
        </SelectContent></Select></Field>
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-sm font-medium">{t("users.activeAccount")}</p><p className="mt-1 text-xs text-muted-foreground">{t("users.activeHint")}</p></div>
        <Switch checked={enabled} disabled={mutation.isPending} onCheckedChange={setEnabled} aria-label={t("users.activeAccount")} />
      </div>
      {local ? <>
        <PasswordPolicyNotice query={policy} />
        <AccountPasswordField label={t("users.newPasswordOptional")} optional value={password} onChange={setPassword} policy={policy.data} disabled={mutation.isPending} />
        {role === "user" ? <ProjectSelection value={projects} onChange={setProjects} disabled={mutation.isPending} /> : <p className="text-sm text-muted-foreground">{t("accountForm.adminHint")}</p>}
      </> : <section className="grid gap-3">
        <p className="text-sm text-muted-foreground">{t("users.ssoHint")}</p>
        <h3 className="text-sm font-medium">{t("users.projects")}</h3>
        <ul className="divide-y">{detail.projects.items.map(project => <li key={project.id} className="py-2 text-sm">{project.name}</li>)}</ul>
        {!detail.projects.items.length && <p className="text-sm">{t("users.noProjects")}</p>}
      </section>}
      <dl className="grid gap-2 border-t pt-4 text-xs">
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("users.created")}</dt><dd>{formatDate(user.created_at, i18n.language)}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("users.lastLogin")}</dt><dd>{user.last_login_at ? formatDate(user.last_login_at, i18n.language) : t("common.never")}</dd></div>
      </dl>
    </form>
  </EntitySheet>;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      {children}
      {hint ? (
        <span className="text-xs font-normal text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "U";
  if (parts.length === 1)
    return Array.from(parts[0]).slice(0, 2).join("").toUpperCase();
  return `${Array.from(parts[0])[0] ?? ""}${Array.from(parts.at(-1) ?? "")[0] ?? ""}`.toUpperCase();
}

function formatDate(value: string, language: string) {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
