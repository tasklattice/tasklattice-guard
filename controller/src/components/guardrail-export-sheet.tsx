import { useTranslation } from "react-i18next";
import { useState, type RefObject } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { downloadGuardrailPackage, getControllerGuardrail, type GuardrailVersion } from "@/lib/controller-api";
import { useDeploymentCapabilities } from "@/lib/deployment";
import { EntitySheet } from "./entity-sheet";
import { ErrorNotice, InfoNotice } from "./product-shell";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Skeleton } from "./ui/skeleton";
import { toast } from "./ui/notifications";

/** Why a published version cannot travel as a self-contained release, if it cannot. */
function exportBlocker(version: GuardrailVersion): "exportImported" | "exportNoTest" | null {
  if (version.origin === "imported") return "exportImported";
  if (!version.validationRunId) return "exportNoTest";
  return null;
}

/** Choose published versions and download them as one signed release package. */
export function ExportGuardrailSheet({ guardrailId, guardrailName, initialVersion, onClose, returnFocusRef }: {
  returnFocusRef?: RefObject<HTMLElement | null>;
  guardrailId: string;
  guardrailName: string;
  initialVersion?: string | undefined;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const capabilities = useDeploymentCapabilities();
  const detail = useQuery({ queryKey: ["guardrail-export-versions", guardrailId], queryFn: () => getControllerGuardrail(guardrailId), staleTime: 0 });
  const versions = [...(detail.data?.versions.filter(version => version.status === "ready" && version.artifactId) ?? [])]
    .sort((left, right) => right.version.localeCompare(left.version));
  const exportable = versions.filter(version => !exportBlocker(version));
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  // Only a version opened from its own menu starts selected; otherwise choose explicitly.
  const selected = chosen ?? new Set(initialVersion && exportable.some(v => v.version === initialVersion) ? [initialVersion] : []);
  const toggle = (version: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(version); else next.delete(version);
    setChosen(next);
    download.reset();
  };
  const download = useMutation({
    mutationFn: () => downloadGuardrailPackage(guardrailId, [...selected].sort()),
    onSuccess: () => { toast.success(t("guardrailPackage.exported")); onClose(); },
  });
  return (
    <EntitySheet
      returnFocusRef={returnFocusRef}
      open
      eyebrow={t("guardrails.export")}
      title={t("guardrailPackage.exportTitle", { name: guardrailName })}
      description={t("guardrailPackage.exportDescription")}
      closeDisabled={download.isPending}
      onOpenChange={open => { if (!open && !download.isPending) onClose(); }}
      footer={<>
        <Button variant="outline" disabled={download.isPending} onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={!selected.size || download.isPending || !capabilities.packageExport.available} onClick={() => download.mutate()}>
          <Download />{download.isPending ? t("guardrailPackage.exporting") : t("guardrailPackage.exportDownload")}
        </Button>
      </>}
    >
      {detail.isPending ? <Skeleton className="h-40" />
        : detail.error ? <ErrorNotice error={detail.error} />
        : !versions.length ? <p className="rounded-lg border border-dashed p-6 text-sm">{t("guardrails.exportRequiresPublish")}</p>
        : <div className="space-y-4">
          {capabilities.known && !capabilities.packageExport.available ? <InfoNotice>{t("guardrailPackage.exportUnavailable")}</InfoNotice> : null}
          <fieldset className="space-y-2">
            <legend className="mb-2 flex w-full items-center justify-between text-sm font-medium">
              <span>{t("guardrailPackage.exportVersions")}</span>
              <span className="text-xs font-normal text-muted-foreground" aria-live="polite">{t("guardrailPackage.selectedCount", { selected: selected.size, total: exportable.length })}</span>
            </legend>
            {versions.map(version => {
              const blocker = exportBlocker(version);
              return <label key={version.version} className={`flex min-h-11 w-full items-center gap-3 rounded-md border px-3 py-2 ${blocker ? "opacity-60" : "cursor-pointer"}`}>
                <Checkbox aria-label={version.version} disabled={Boolean(blocker)} checked={selected.has(version.version)} onCheckedChange={on => toggle(version.version, on)} />
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-sm">{version.version}</span>
                  <span className="text-xs text-muted-foreground">{t("guardrails.publishedAt", { time: new Date(version.createdAt).toLocaleString(i18n.language) })}</span>
                  {blocker ? <span className="w-full text-xs text-muted-foreground">{t(`guardrailPackage.${blocker}`)}</span> : null}
                </span>
              </label>;
            })}
          </fieldset>
          {download.error && <ErrorNotice error={download.error} />}
        </div>}
    </EntitySheet>
  );
}
