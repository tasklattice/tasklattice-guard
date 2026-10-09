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
import { percent } from "./form";
import { EnvironmentStatus } from "@/components/guardrail-import-sheet";

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
  fallback = false,
}: {
  value: RouteTarget[];
  onChange: (value: RouteTarget[]) => void;
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
  fallback,
}: {
  target: RouteTarget;
  index: number;
  single: boolean;
  options: Array<{ id: string; name: string }>;
  onChange: (value: RouteTarget) => void;
  onRemove: () => void;
  fallback: boolean;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["routing-guardrail", target.guardrailId],
    queryFn: () => getControllerGuardrail(target.guardrailId),
    enabled: Boolean(target.guardrailId),
  });
  // Newest first. Every target pins one immutable version, chosen explicitly.
  const versions =
    query.data?.versions.filter(
      (version) => version.status === "ready" && version.artifactId,
    ).sort((left, right) => right.version.localeCompare(left.version)) ?? [];
  // Imported content is served only after Runners here confirm they can load it.
  const chosen = versions.find((version) => version.version === target.guardrailVersion);
  const chosenImported = chosen?.origin === "imported" ? chosen : undefined;
  useEffect(() => {
    if (single && target.weightBps !== 10000) onChange({ ...target, weightBps: 10000 });
  }, [target.guardrailId, target.guardrailVersion, target.weightBps, single]);
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
      {target.guardrailId && (
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
                {version.version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {chosenImported ? <div className="space-y-1">
        <EnvironmentStatus check={chosenImported.environmentCheck} />
        <p className="text-xs text-muted-foreground">{t("routing.importedVersionCheckedOnSubmit")}</p>
      </div> : null}
      {query.error && <ErrorNotice error={query.error} />}
      {query.data && !versions.length && (
        <p className="text-xs text-muted-foreground">
          {t("routing.publishThisGuardrailToMakeAVersionAvailable")}
        </p>
      )}
    </div>
  );
}
