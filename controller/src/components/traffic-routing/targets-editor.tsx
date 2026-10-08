import { useTranslation } from "react-i18next";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getControllerGuardrail,
  listControllerGuardrails,
} from "@/lib/controller-api";
import type { RouteTarget } from "@/lib/traffic-routing-api";
import { ErrorNotice } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, percent } from "./form";

export function distributeEqually(targets: RouteTarget[]): RouteTarget[] {
  const weight = targets.length ? Math.floor(10000 / targets.length) : 0;
  return targets.map((target, index) => ({
    ...target,
    weightBps: weight + (index < 10000 % targets.length ? 1 : 0),
  }));
}

export function TargetsEditor({
  value,
  onChange,
  allowLatest = false,
  fallback = false,
}: {
  value: RouteTarget[];
  onChange: (value: RouteTarget[]) => void;
  allowLatest?: boolean;
  fallback?: boolean;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["routing-guardrails"],
    queryFn: listControllerGuardrails,
  });
  const total = value.reduce((sum, target) => sum + target.weightBps, 0);
  return (
    <div className="space-y-3">
      {query.error && <ErrorNotice error={query.error} />}
      {value.map((target, index) => (
        <TargetRow
          key={target.id}
          target={target}
          index={index}
          single={value.length === 1}
          allowLatest={allowLatest}
          fallback={fallback}
          options={query.data?.items ?? []}
          onChange={(next) =>
            onChange(value.map((item) => (item.id === target.id ? next : item)))
          }
          onRemove={() =>
            onChange(
              distributeEqually(value.filter((item) => item.id !== target.id)),
            )
          }
        />
      ))}
      {(!fallback || !value.length) && (
        <Button
          variant="create"
          disabled={value.length >= 32 || query.isPending}
          onClick={() =>
            onChange(
              distributeEqually([
                ...value,
                {
                  id: crypto.randomUUID(),
                  guardrailId: "",
                  guardrailVersion: "",
                  weightBps: 0,
                  ...(allowLatest
                    ? { versionStrategy: "latest" as const }
                    : {}),
                },
              ]),
            )
          }
        >
          {t("routing.addGuardrail")}
        </Button>
      )}
      {value.length === 1 && (
        <p className="text-xs text-muted-foreground">
          {t("routing.allMatchingTrafficGoesToThisGuardrail100")}
        </p>
      )}
      {value.length > 1 && (
        <p
          role="status"
          className={
            total === 10000
              ? "text-xs text-muted-foreground"
              : "text-xs text-destructive"
          }
        >
          {t("routing.totalDistribution")}: {percent(total)}
          {total !== 10000 && t("routing.adjustTo100")}
        </p>
      )}
    </div>
  );
}

function TargetRow({
  target,
  index,
  single,
  options,
  onChange,
  onRemove,
  allowLatest,
  fallback,
}: {
  target: RouteTarget;
  index: number;
  single: boolean;
  options: Array<{ id: string; name: string }>;
  onChange: (value: RouteTarget) => void;
  onRemove: () => void;
  allowLatest: boolean;
  fallback: boolean;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["routing-guardrail", target.guardrailId],
    queryFn: () => getControllerGuardrail(target.guardrailId),
    enabled: Boolean(target.guardrailId),
  });
  const versionStrategyLabel = t("routing.versionStrategy", { index: index + 1 });
  const versions =
    query.data?.versions.filter(
      (version) => version.status === "ready" && version.artifactId,
    ) ?? [];
  // Pinning starts from the Guardrail's Latest version, the one "Use latest" would resolve to.
  const latestVersion = versions.find((version) => version.version === query.data?.latestVersion)?.version;
  const defaultVersion = latestVersion ?? versions[0]?.version;
  useEffect(() => {
    const guardrailVersion =
      target.versionStrategy === "latest"
        ? ""
        : target.guardrailVersion || defaultVersion || "";
    const weightBps = single ? 10000 : target.weightBps;
    if (
      guardrailVersion !== target.guardrailVersion ||
      weightBps !== target.weightBps
    ) {
      onChange({ ...target, guardrailVersion, weightBps });
    }
  }, [
    target.guardrailId,
    target.guardrailVersion,
    target.versionStrategy,
    target.weightBps,
    defaultVersion,
    single,
  ]);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className={`grid items-center gap-2 ${single ? (fallback ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_3rem]") : "grid-cols-[minmax(0,1fr)_6rem_3rem]"}`}>
        <div className="min-w-0 flex-1">
          <MultiSelectCombobox
            ariaLabel={`Guardrail ${index + 1}`}
            selectionMode="single"
            options={options.map((option) => ({
              value: option.id,
              label: option.name,
            }))}
            value={target.guardrailId ? [target.guardrailId] : []}
            onValueChange={(ids) =>
              onChange({
                ...target,
                guardrailId: ids[0] ?? "",
                guardrailVersion: "",
              })
            }
            placeholder={t("routing.searchOrSelectAGuardrail")}
          />
        </div>
        {!single && (
          <div className="relative min-w-0">
              <Input
                aria-label={`Guardrail ${index + 1} %`}
                className="field:h-12 field:pr-7 [appearance:textfield] field:[&::-webkit-inner-spin-button]:appearance-none field:[&::-webkit-outer-spin-button]:appearance-none"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={target.weightBps / 100}
                onChange={(event) =>
                  onChange({
                    ...target,
                    weightBps: Math.round(Number(event.target.value) * 100),
                  })
                }
              />
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">%</span>
          </div>
        )}
        {!fallback && (
          <Button
            variant="destructive"
            className="size-12 shrink-0"
            aria-label={t("routing.removeGuardrail", { index: index + 1 })}
            onClick={onRemove}
          >
            ×
          </Button>
        )}
      </div>
      {target.guardrailId && allowLatest && (
        <Field label={versionStrategyLabel}>
          <Select
            value={target.versionStrategy ?? "pinned"}
            onValueChange={(strategy) =>
              onChange({
                ...target,
                versionStrategy: strategy as "latest" | "pinned",
                guardrailVersion:
                  strategy === "latest" ? "" : (defaultVersion ?? ""),
              })
            }
          >
            <SelectTrigger
              aria-label={versionStrategyLabel}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">{t("routing.useLatest")}</SelectItem>
              <SelectItem value="pinned">{t("routing.pinVersion")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
      {target.guardrailId && target.versionStrategy === "latest" && query.data && (
        <p className="text-xs text-muted-foreground">
          {latestVersion ? t("routing.useLatestResolves", { version: latestVersion }) : t("routing.noLatestVersion")}
        </p>
      )}
      {target.guardrailId && target.versionStrategy !== "latest" && (
        <Select
          value={target.guardrailVersion}
          onValueChange={(guardrailVersion) =>
            onChange({ ...target, guardrailVersion })
          }
        >
          <SelectTrigger aria-label={t("routing.targetVersion", { index: index + 1 })}>
            <SelectValue placeholder={t("routing.selectVersion")} />
          </SelectTrigger>
          <SelectContent>
            {versions.map((version) => (
              <SelectItem key={version.version} value={version.version}>
                {version.version === latestVersion ? t("routing.versionIsLatest", { version: version.version }) : version.version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {query.error && <ErrorNotice error={query.error} />}
      {query.data && !versions.length && (
        <p className="text-xs text-muted-foreground">
          {t("routing.publishThisGuardrailToMakeAVersionAvailable")}
        </p>
      )}
    </div>
  );
}
