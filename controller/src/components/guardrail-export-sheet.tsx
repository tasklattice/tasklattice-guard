import { useTranslation } from "react-i18next";
import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { getControllerGuardrail } from "@/lib/controller-api";
import { downloadGuardrailArtifact } from "@/lib/guardrail-export";
import { guardrailArtifactFilename } from "../../shared/guardrail-export";
import { EntitySheet } from "./entity-sheet";
import { ErrorNotice, StateBadge } from "./product-shell";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Skeleton } from "./ui/skeleton";
import { toast } from "./ui/notifications";

/** Choose one ready immutable version and download its signed Artifact. */
export function ExportGuardrailSheet({ guardrailId, guardrailName, initialVersion, onClose }: {
  guardrailId: string;
  guardrailName: string;
  initialVersion?: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const detail = useQuery({ queryKey: ["guardrail-export-versions", guardrailId], queryFn: () => getControllerGuardrail(guardrailId), staleTime: 0 });
  const versions = detail.data?.versions.filter(version => version.status === "ready" && version.artifactId) ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = chosen ?? (versions.some(v => v.version === initialVersion) ? initialVersion! : detail.data?.latestVersion ?? versions[0]?.version ?? null);
  const download = useMutation({
    mutationFn: (version: string) => downloadGuardrailArtifact(guardrailId, version),
    onSuccess: () => { toast.success(t("guardrails.exportSucceeded")); onClose(); },
  });
  return (
    <EntitySheet
      open
      eyebrow={t("guardrails.export")}
      title={t("guardrails.exportTitle", { name: guardrailName })}
      description={t("guardrails.exportDescription")}
      closeDisabled={download.isPending}
      onOpenChange={open => { if (!open && !download.isPending) onClose(); }}
      footer={<>
        <Button variant="outline" disabled={download.isPending} onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={!selected || download.isPending} onClick={() => { if (selected) download.mutate(selected); }}>
          <Download />{download.isPending ? t("guardrails.exporting") : t("guardrails.downloadArtifact")}
        </Button>
      </>}
    >
      {detail.isPending ? <Skeleton className="h-40" />
        : detail.error ? <ErrorNotice error={detail.error} />
        : !versions.length ? <p className="rounded-lg border border-dashed p-6 text-sm">{t("guardrails.exportRequiresPublish")}</p>
        : <div className="space-y-4">
          <RadioGroup className="w-full [&_.cds--radio-button-group]:w-full" legendText={t("guardrails.exportVersion")} orientation="vertical" value={selected ?? ""} onValueChange={value => { setChosen(value); download.reset(); }}>
            {versions.map(version => <ExportVersionOption key={version.version} version={version.version} createdAt={version.createdAt} latest={version.version === detail.data.latestVersion} />)}
          </RadioGroup>
          {selected && <p className="text-xs text-muted-foreground">{t("guardrails.exportFilename")} <code className="font-mono">{guardrailArtifactFilename(guardrailId, selected)}</code></p>}
          {download.error && <ErrorNotice error={download.error} />}
        </div>}
    </EntitySheet>
  );
}

function ExportVersionOption({ version, createdAt, latest }: { version: string; createdAt: string; latest: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="flex w-full self-stretch items-center gap-3 rounded-md border px-3 py-2">
      <RadioGroupItem id={id} value={version} />
      <Label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-sm">{version}</span>
        {latest && <StateBadge state="active" label={t("guardrails.latestVersionLabel")} />}
        <span className="text-xs font-normal text-muted-foreground">{t("guardrails.publishedAt", { time: new Date(createdAt).toLocaleString() })}</span>
      </Label>
    </div>
  );
}
