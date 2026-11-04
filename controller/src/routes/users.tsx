import { hasPermission } from "../../shared/rbac";
import { useEffect, useState } from "react";
import {
  keepPreviousData,
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
          <Button onClick={() => setCreateOpen(true)}>
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
              onClick={() => setSelected(item.id)}
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
      <CreateUserSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          void refresh();
        }}
      />
      {selected && (
        <UserDetailPanel
          key={selected}
          id={selected}
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
}: {
  id: string;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { t } = useTranslation();
  const control = useDirectoryPage(`user-projects:${id}`);
  const query = useQuery({
    queryKey: ["user-detail", id, control.query],
    queryFn: ({ signal }) => getUser(id, control.query, signal),
    placeholderData: keepPreviousData,
  });
  if (!query.data)
    return (
      <EntitySheet
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
      detail={query.data}
      control={control}
      busy={query.isFetching}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onUpdated={onUpdated}
    />
  );
}

function CreateUserSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<IdentityRole>("user");
  const [language, setLanguage] = useState<"en" | "zh-CN">("en");
  useEffect(() => {
    if (open) {
      setUsername("");
      setPassword("");
      setRole("user");
      setLanguage("en");
    }
  }, [open]);
  const mutation = useMutation({
    mutationFn: () =>
      createUser({
        username,
        password,
        role,
        preferred_language: language,
      }),
    onSuccess: () => {
      toast.success(t("users.added"));
      onCreated();
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : t("common.unknownError"),
      ),
  });
  return (
    <EntitySheet
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={t("users.eyebrow")}
      title={t("users.createTitle")}
      description={t("users.createDescription")}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              !username.trim() ||
              password.length < 8 ||
              mutation.isPending
            }
            onClick={() => mutation.mutate()}
          >
            <Plus />
            {mutation.isPending ? t("common.creating") : t("common.create")}
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        <Field label={t("auth.username")}>
          <Input
            type="text"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field label={t("common.password")} hint={t("auth.passwordHint")}>
          <Input
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("common.role")}>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as IdentityRole)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t("common.member")}</SelectItem>
                <SelectItem value="admin">{t("common.admin")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("common.language")}>
            <Select
              value={language}
              onValueChange={(value) => setLanguage(value as typeof language)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">{t("common.english")}</SelectItem>
                <SelectItem value="zh-CN">{t("common.chinese")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </div>
    </EntitySheet>
  );
}

function EditUserSheet({
  detail,
  control,
  busy,
  onOpenChange,
  onUpdated,
}: {
  detail: UserDetail;
  control: ReturnType<typeof useDirectoryPage>;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (user: IdentityUser) => void;
}) {
  const user = detail.user;
  const { t, i18n } = useTranslation();
  const [role, setRole] = useState<IdentityRole>("user");
  const [enabled, setEnabled] = useState(true);
  const [password, setPassword] = useState("");
  useEffect(() => {
    if (user) {
      setRole(user.role);
      setEnabled(user.enabled);
      setPassword("");
    }
  }, [user.id]);
  const mutation = useMutation({
    mutationFn: () =>
      updateUser(user!.id, {
        enabled,
        ...(detail.source === "local"
          ? { role, password: password || undefined }
          : {}),
      }),
    onSuccess: (updated) => {
      toast.success(t("users.updated"));
      onUpdated(updated);
      setPassword("");
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : t("common.unknownError"),
      ),
  });
  if (!user) return null;
  return (
    <EntitySheet
      open
      onOpenChange={onOpenChange}
      eyebrow={`${t("users.user")} / ${user.username || user.email}`}
      title={t("users.editTitle")}
      description={t("users.editDescription")}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              (password.length > 0 && password.length < 8) ||
              mutation.isPending
            }
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-4">
          <Avatar className="size-10">
            <AvatarFallback>{initials(user.username)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user.username}</p>
          </div>
        </div>
        <Field label={t("common.role")}>
          <Select
            disabled={detail.source !== "local"}
            value={role}
            onValueChange={(value) => setRole(value as IdentityRole)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">{t("common.member")}</SelectItem>
              <SelectItem value="admin">{t("common.admin")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
          <div>
            <p className="text-sm font-medium">{t("users.activeAccount")}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("users.activeHint")}
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label={t("users.activeAccount")}
          />
        </div>
        {detail.source === "sso" && (
          <p className="text-sm leading-6 text-muted-foreground">
            {t("users.ssoHint")}
          </p>
        )}
        {detail.source === "local" && (
          <Field
            label={t("users.newPasswordOptional")}
            hint={t("users.resetHint")}
          >
            <Input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        )}
        <section>
          <h3 className="mb-3 text-sm font-medium">{t("users.projects")}</h3>
          <Input
            aria-label={t("projects.search")}
            placeholder={t("projects.search")}
            value={control.search}
            onChange={(e) => control.setSearch(e.target.value)}
          />
          <ul className="divide-y">
            {detail.projects.items.map((project) => (
              <li key={project.id} className="py-3 text-sm">
                {project.name}
              </li>
            ))}
          </ul>
          <DirectoryPagination
            control={control}
            count={detail.projects.items.length}
            nextCursor={detail.projects.nextCursor}
            busy={busy}
          />
        </section>
        <dl className="grid gap-2 rounded-xl bg-muted/35 p-4 text-xs">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t("users.created")}</dt>
            <dd>{formatDate(user.created_at, i18n.language)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t("users.lastLogin")}</dt>
            <dd>
              {user.last_login_at
                ? formatDate(user.last_login_at, i18n.language)
                : t("common.never")}
            </dd>
          </div>
        </dl>
      </div>
    </EntitySheet>
  );
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
