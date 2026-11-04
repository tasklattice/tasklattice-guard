import { DirectoryPicker } from "@/components/directory-picker";
import { hasPermission } from "../../shared/rbac";
import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Share2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import {
  EmptyState,
  ErrorNotice,
  PageHeader,
} from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import {
  createShare,
  listShareableResources,
  listShares,
  listProjects,
  revokeShare,
  type ShareableResource,
} from "@/lib/sharing-api";

const sharingKeys = {
  projects: ["sharing", "projects"] as const,
  resources: ["sharing", "owned-resources"] as const,
  grants: ["sharing", "grants"] as const,
};

export function SharingPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const client = useQueryClient();
  const resources = useQuery({
    queryKey: sharingKeys.resources,
    queryFn: listShareableResources,
  });
  const grants = useQuery({
    queryKey: sharingKeys.grants,
    queryFn: listShares,
  });
  const [resourceKey, setResourceKey] = useState("");
  const [recipientProjectId, setRecipientProjectId] = useState("");

  const owned = resources.data?.items ?? [];
  const selected = useMemo(
    () => owned.find((resource) => keyFor(resource) === resourceKey),
    [owned, resourceKey],
  );
  const existingGrant =
    selected &&
    grants.data?.items.some(
      (grant) =>
        grant.resourceType === selected.resourceType &&
        grant.resourceId === selected.resourceId &&
        grant.recipientProjectId === recipientProjectId,
    );
  const resourceNames = new Map(
    owned.map((resource) => [keyFor(resource), resource.name]),
  );

  const create = useMutation({
    mutationFn: () =>
      createShare({
        resourceType: selected!.resourceType,
        resourceId: selected!.resourceId,
        recipientProjectId,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: sharingKeys.grants });
      toast.success(t("sharing.created"));
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : t("common.unknownError"),
      ),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeShare(id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: sharingKeys.grants });
      toast.success(t("sharing.revoked"));
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : t("common.unknownError"),
      ),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected && recipientProjectId && !existingGrant) create.mutate();
  }

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("sharing.title")}
        description={t("sharing.description", {
          project: user?.project_id ?? "",
        })}
      />
      {resources.error || grants.error ? (
        <div className="mt-5">
          <ErrorNotice error={resources.error || grants.error} />
        </div>
      ) : null}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t("sharing.ownedTitle")}</CardTitle>
            <CardDescription>{t("sharing.ownedDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {owned.length ? (
              <div className="divide-y rounded-lg border">
                {owned.map((resource) => (
                  <div
                    key={keyFor(resource)}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <span className="min-w-0">
                      <strong className="block truncate text-sm font-medium">
                        {resource.name}
                      </strong>
                      <span className="block truncate text-xs text-muted-foreground">
                        {resource.resourceId}
                      </span>
                    </span>
                    <Badge variant="outline" className="shrink-0">
                      {resourceLabel(resource.resourceType, t)}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : !resources.isLoading ? (
              <EmptyState
                title={t("sharing.noOwnedTitle")}
                description={t("sharing.noOwnedDescription")}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("sharing.loading")}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("sharing.createTitle")}</CardTitle>
            <CardDescription>{t("sharing.createDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            {!hasPermission(user?.role, "guardrails", "write") ? (
              <p className="text-sm text-muted-foreground">
                {t("sharing.adminRequired")}
              </p>
            ) : (
              <form className="grid gap-4" onSubmit={submit}>
                <label
                  className="grid gap-2 text-sm font-medium"
                  htmlFor="sharing-resource"
                >
                  {t("sharing.resource")}
                  <select
                    id="sharing-resource"
                    value={resourceKey}
                    onChange={(event) => setResourceKey(event.target.value)}
                    className="min-h-11 rounded-md border border-input bg-background px-3 text-sm"
                    required
                  >
                    <option value="">{t("sharing.chooseResource")}</option>
                    {owned.map((resource) => (
                      <option key={keyFor(resource)} value={keyFor(resource)}>
                        {resourceLabel(resource.resourceType, t)} ·{" "}
                        {resource.name}
                      </option>
                    ))}
                  </select>
                </label>
                {selected && (
                  <DirectoryPicker
                    scope="share-recipient"
                    label={t("sharing.recipient")}
                    value={recipientProjectId}
                    onChange={setRecipientProjectId}
                    load={listProjects}
                  />
                )}
                {existingGrant ? (
                  <p className="text-xs text-muted-foreground">
                    {t("sharing.alreadyShared")}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  disabled={
                    !selected ||
                    !recipientProjectId ||
                    Boolean(existingGrant) ||
                    create.isPending
                  }
                >
                  <Share2 />
                  {create.isPending
                    ? t("sharing.creating")
                    : t("sharing.share")}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>{t("sharing.grantsTitle")}</CardTitle>
          <CardDescription>{t("sharing.grantsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {grants.data?.items.length ? (
            <div className="divide-y rounded-lg border">
              {grants.data.items.map((grant) => (
                <div
                  key={grant.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap"
                >
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm font-medium">
                      {resourceNames.get(
                        `${grant.resourceType}:${grant.resourceId}`,
                      ) ?? grant.resourceId}
                    </strong>
                    <span className="block text-xs text-muted-foreground">
                      {resourceLabel(grant.resourceType, t)} ·{" "}
                      {t("sharing.sharedWith", {
                        project: grant.recipientProjectId,
                      })}{" "}
                      ·{" "}
                      {new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: "medium",
                      }).format(new Date(grant.createdAt))}
                    </span>
                  </span>
                  {hasPermission(user?.role, "guardrails", "write") ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(grant.id)}
                      aria-label={t("sharing.revokeFor", {
                        resource:
                          resourceNames.get(
                            `${grant.resourceType}:${grant.resourceId}`,
                          ) ?? grant.resourceId,
                        project: grant.recipientProjectId,
                      })}
                    >
                      <Trash2 className="size-4" />
                      {t("sharing.revoke")}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : !grants.isLoading ? (
            <EmptyState
              title={t("sharing.noGrantsTitle")}
              description={t("sharing.noGrantsDescription")}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("sharing.loading")}
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function keyFor(
  resource: Pick<ShareableResource, "resourceType" | "resourceId">,
) {
  return `${resource.resourceType}:${resource.resourceId}`;
}

function resourceLabel(
  type: ShareableResource["resourceType"],
  t: (key: string) => string,
) {
  return t(`sharing.type.${type}`);
}
