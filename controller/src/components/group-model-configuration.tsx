import "./group-model-configuration.scss";
import { useState, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EntitySheet } from "@/components/entity-sheet";
import { ErrorNotice } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import {
  getModelConfiguration,
  type ModelConfigurationRevision,
  type ModelConfigurationView,
} from "@/lib/controller-api";
import {
  getGroupModelConfiguration,
  groupModelConfigurationKey,
  updateGroupModelConfiguration,
  type GroupModelConfigurationView,
} from "@/lib/project-groups-api";
import type { GroupModelConfigurationMode } from "../../shared/group-model-configuration";
import type { ProjectGroupsCopy } from "@/project-groups-i18n";

type Props = {
  group: { id: string; name: string };
  copy: ProjectGroupsCopy;
  scopeDescription: string;
  onClose: () => void;
  onDismiss?: () => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
};
const catalogKey = ["settings", "group-model-catalog"] as const;
const queryOptions = {
  retry: false,
  throwOnError: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export function GroupModelConfigurationSheet(props: Props) {
  const policy = useQuery({
    queryKey: groupModelConfigurationKey(props.group.id),
    queryFn: ({ signal }) => getGroupModelConfiguration(props.group.id, signal),
    ...queryOptions,
  });
  const catalog = useQuery({
    queryKey: catalogKey,
    queryFn: getModelConfiguration,
    ...queryOptions,
  });
  const [review, setReview] = useState(0);
  async function refresh() {
    await Promise.all([policy.refetch(), catalog.refetch()]);
    setReview((value) => value + 1);
  }
  if (
    policy.data &&
    !policy.isError &&
    !policy.isFetching &&
    !catalog.isPending
  )
    return (
      <ConfigurationForm
        {...props}
        key={`${policy.data.version}:${review}`}
        policy={policy.data}
        catalog={catalog.isError ? undefined : catalog.data}
        catalogPending={catalog.isFetching}
        onRefresh={refresh}
      />
    );
  return (
    <EntitySheet
      open
      onOpenChange={(open) => {
        if (!open) (props.onDismiss ?? props.onClose)();
      }}
      width="md"
      returnFocusRef={props.returnFocusRef}
      eyebrow={props.copy.groups}
      title={`${props.copy.runtimeModels} · ${props.group.name}`}
      description={props.scopeDescription}
      footer={
        <>
          <Button variant="outline" onClick={props.onClose}>
            {props.copy.cancel}
          </Button>
          <Button disabled={policy.isFetching} onClick={() => void refresh()}>
            {props.copy.review}
          </Button>
        </>
      }
    >
      {policy.isError ? (
        <p role="alert">{props.copy.modelsUnavailable}</p>
      ) : (
        <p role="status">{props.copy.loading}</p>
      )}
    </EntitySheet>
  );
}

function ConfigurationForm({
  group,
  copy,
  onClose,
  onDismiss,
  returnFocusRef,
  policy,
  scopeDescription,
  catalog,
  catalogPending,
  onRefresh,
}: Props & {
  policy: GroupModelConfigurationView;
  catalog?: ModelConfigurationView;
  catalogPending: boolean;
  onRefresh: () => Promise<void>;
}) {
  const client = useQueryClient();
  const [mode, setMode] = useState<GroupModelConfigurationMode>(policy.mode);
  const [sourceId, setSourceId] = useState("");
  // Keep exactly the displayed revision/fingerprint until an explicit review.
  // Background cache changes must not silently change the grant being approved.
  const [reviewedCatalog] = useState(catalog);
  const sources = [reviewedCatalog?.draft, reviewedCatalog?.active].filter(
    (source): source is ModelConfigurationRevision =>
      Boolean(
        source &&
          ["validated", "active", "superseded"].includes(source.state) &&
          source.validationReport?.valid &&
          /^[a-f0-9]{64}$/.test(
            source.validationReport.runtimeFingerprint ?? "",
          ),
      ),
  );
  const source = sources.find((item) => item.id === sourceId);
  const selection = Object.entries(source?.assignments.bindings ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  const mutation = useMutation({
    mutationFn: () => {
      if (mode === "scoped") {
        if (!source?.validationReport?.runtimeFingerprint)
          throw new Error(copy.modelsChooseSource);
        return updateGroupModelConfiguration(group.id, {
          mode,
          expectedVersion: policy.version,
          sourceRevisionId: source.id,
          expectedSourceFingerprint: source.validationReport.runtimeFingerprint,
        });
      }
      return updateGroupModelConfiguration(group.id, {
        mode,
        expectedVersion: policy.version,
      });
    },
    retry: false,
    onSuccess: (updated) => {
      client.setQueryData(groupModelConfigurationKey(group.id), updated);
      onClose();
    },
  });
  const valid = mode === "scoped" ? Boolean(source) : mode !== policy.mode;
  return (
    <EntitySheet
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) (onDismiss ?? onClose)();
      }}
      closeDisabled={mutation.isPending}
      width="md"
      returnFocusRef={returnFocusRef}
      eyebrow={copy.groups}
      title={`${copy.runtimeModels} · ${group.name}`}
      description={scopeDescription}
      footer={
        <>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            {copy.cancel}
          </Button>
          <Button
            disabled={!valid || mutation.isPending || mutation.isError}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? copy.saving : copy.modelsApply}
          </Button>
        </>
      }
    >
      <div className="project-group-form group-model-configuration">
        <dl className="project-group-facts">
          <div>
            <dt>{copy.modelsCurrent}</dt>
            <dd>
              {modeLabel(policy.mode, copy)}
              <small>
                {copy.modelsPolicyVersion} {policy.version}
              </small>
            </dd>
          </div>
          <div>
            <dt>{copy.modelsGranted}</dt>
            <dd>
              {policy.modelIds.length ? policy.modelIds.join(", ") : copy.empty}
            </dd>
          </div>
        </dl>
        {mutation.error ? (
          <>
            <ErrorNotice error={mutation.error} />
            <p>{copy.modelsConflict}</p>
          </>
        ) : null}
        <Button
          variant="link"
          size="sm"
          disabled={mutation.isPending}
          onClick={() => void onRefresh()}
        >
          {copy.review}
        </Button>
        <label className="project-group-field">
          <span>{copy.modelsMode}</span>
          <select
            aria-label={copy.modelsMode}
            value={mode}
            disabled={mutation.isPending}
            onChange={(event) =>
              setMode(event.target.value as GroupModelConfigurationMode)
            }
          >
            {(["platform", "scoped", "blocked"] as const)
              .filter((value) => value !== "platform" || group.id === "default")
              .map((value) => (
                <option key={value} value={value}>
                  {modeLabel(value, copy)}
                </option>
              ))}
          </select>
        </label>
        <p className="project-group-note">
          {mode === "platform"
            ? copy.modelsPlatformHint
            : mode === "blocked"
              ? copy.modelsBlockedHint
              : copy.modelsScopedHint}
        </p>
        {mode === "scoped" ? (
          <>
            <label className="project-group-field">
              <span>{copy.modelsSource}</span>
              <select
                aria-label={copy.modelsSource}
                value={sourceId}
                disabled={mutation.isPending || catalogPending}
                onChange={(event) => setSourceId(event.target.value)}
              >
                <option value="">{copy.modelsChooseSource}</option>
                {sources.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.state} · {item.id}
                  </option>
                ))}
              </select>
            </label>
            {!reviewedCatalog || !sources.length ? (
              <p role="status">
                {catalogPending ? copy.loading : copy.modelsNoSource}{" "}
                <Link to="/settings/guardrail-catalog">
                  {copy.modelsSettings}
                </Link>
              </p>
            ) : null}
            {source ? (
              <div>
                <h3>{copy.modelsBindings}</h3>
                <ul>
                  {selection.map(([binding, id]) => {
                    const model = reviewedCatalog?.models.find(
                      (item) => item.id === id,
                    );
                    return (
                      <li key={binding}>
                        {binding}: {model?.name ?? id} ·{" "}
                        {model?.providerName ?? id}
                      </li>
                    );
                  })}
                </ul>
                <p>
                  {copy.modelsValidatedAt}{" "}
                  {source.validatedAt
                    ? new Date(source.validatedAt).toLocaleString()
                    : "—"}
                </p>
              </div>
            ) : null}
          </>
        ) : null}
        <p className="project-group-note" data-warning="true">
          {copy.modelsCredentialLimit}
        </p>
      </div>
    </EntitySheet>
  );
}

function modeLabel(mode: GroupModelConfigurationMode, copy: ProjectGroupsCopy) {
  return mode === "platform"
    ? copy.modelsPlatform
    : mode === "scoped"
      ? copy.modelsScoped
      : copy.modelsBlocked;
}
