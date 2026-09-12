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
import { Field, percent, useRoutingText } from "./form";

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
  const t = useRoutingText();
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
          {t("添加 Guardrail", "Add Guardrail")}
        </Button>
      )}
      {value.length === 1 && (
        <p className="text-xs text-muted-foreground">
          {t(
            "匹配的流量全部转发到此 Guardrail（100%）。",
            "All matching traffic goes to this Guardrail (100%).",
          )}
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
          {t("分发比例合计", "Total distribution")}: {percent(total)}
          {total !== 10000 && t("，请调整为 100%。", ". Adjust to 100%.")}
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
  const t = useRoutingText();
  const query = useQuery({
    queryKey: ["routing-guardrail", target.guardrailId],
    queryFn: () => getControllerGuardrail(target.guardrailId),
    enabled: Boolean(target.guardrailId),
  });
  const versions =
    query.data?.versions.filter(
      (version) => version.status === "ready" && version.artifactId,
    ) ?? [];
  const defaultVersion = versions[0]?.version;
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
            placeholder={t(
              "搜索或选择 Guardrail…",
              "Search or select a Guardrail…",
            )}
          />
        </div>
        {!single && (
          <div className="relative min-w-0">
              <Input
                aria-label={`Guardrail ${index + 1} %`}
                className="h-12 pr-7 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
            aria-label={`Remove Guardrail ${index + 1}`}
            onClick={onRemove}
          >
            ×
          </Button>
        )}
      </div>
      {target.guardrailId && allowLatest && (
        <Field label={t("版本策略", "Version strategy")}>
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
              aria-label={`Guardrail ${index + 1} version strategy`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">Latest when published</SelectItem>
              <SelectItem value="pinned">Pin version</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
      {target.guardrailId && target.versionStrategy !== "latest" && (
        <Select
          value={target.guardrailVersion}
          onValueChange={(guardrailVersion) =>
            onChange({ ...target, guardrailVersion })
          }
        >
          <SelectTrigger aria-label={`Guardrail ${index + 1} version`}>
            <SelectValue placeholder={t("选择版本", "Select version")} />
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
      {query.error && <ErrorNotice error={query.error} />}
      {query.data && !versions.length && (
        <p className="text-xs text-muted-foreground">
          {t(
            "此 Guardrail 尚无就绪版本，请先发布。",
            "Publish this Guardrail to make a version available.",
          )}
        </p>
      )}
    </div>
  );
}
