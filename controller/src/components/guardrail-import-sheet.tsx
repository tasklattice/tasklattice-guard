import { useRef, useState, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Circle, FileArchive, LoaderCircle, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { queryKeys } from "@/features/query-keys";
import { importGuardrailPackage, uploadGuardrailPackage, type EnvironmentCheck, type PackagePreview } from "@/lib/controller-api";
import { EntitySheet } from "./entity-sheet";
import { ErrorNotice, InfoNotice, StateBadge } from "./product-shell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { toast } from "./ui/notifications";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

type Step = "read" | "verify" | "environment" | "write";
const STEPS: Step[] = ["read", "verify", "environment", "write"];

/** Upload a signed release package, review what it would change, then import it. */
export function ImportGuardrailSheet({ onClose, returnFocusRef }: { onClose: () => void; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const upload = useMutation({ mutationFn: uploadGuardrailPackage });
  const preview = upload.data;
  const fresh = preview?.versions.filter(item => item.state === "new") ?? [];
  const importing = useMutation({
    mutationFn: (value: PackagePreview) => importGuardrailPackage(value.packageId),
    onSuccess: async result => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.guardrails }),
        queryClient.invalidateQueries({ queryKey: queryKeys.guardrail(result.guardrailId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.guardrailVersions(result.guardrailId) }),
      ]);
      toast.success(t("guardrailPackage.imported", { imported: result.imported.length, existing: result.existing.length }));
      onClose();
      void navigate({ to: "/guardrails/$guardrailId", params: { guardrailId: result.guardrailId }, search: { tab: "immutable" } });
    },
  });
  const busy = upload.isPending || importing.isPending;
  const done = (step: Step) => step === "read" ? Boolean(file) : step === "write" ? importing.isSuccess : Boolean(preview);
  const active = (step: Step) => (step === "write" && importing.isPending) || ((step === "verify" || step === "environment") && upload.isPending);
  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    setFile(chosen);
    importing.reset();
    upload.mutate(chosen);
  };

  return (
    <EntitySheet open width="xl" returnFocusRef={returnFocusRef}
      eyebrow={t("guardrailPackage.import")} title={t("guardrailPackage.importTitle")} description={t("guardrailPackage.importDescription")}
      closeDisabled={importing.isPending} onOpenChange={open => { if (!open && !importing.isPending) onClose(); }}
      footer={<>
        <Button variant="outline" disabled={importing.isPending} onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={!preview || busy || preview.blockers.length > 0 || fresh.length === 0} onClick={() => { if (preview) importing.mutate(preview); }}>
          {importing.isPending ? <LoaderCircle className="animate-spin" /> : <Upload />}
          {importing.isPending ? t("guardrailPackage.importing") : !preview || fresh.length === 0 ? t("guardrailPackage.nothingToImport")
            : fresh.length === 1 ? t("guardrailPackage.importOne") : t("guardrailPackage.importAction", { count: fresh.length })}
        </Button>
      </>}>
      <div className="space-y-5">
        <input ref={input} type="file" accept=".zip,application/zip" className="hidden" aria-label={t("guardrailPackage.chooseFile")}
          onChange={event => { choose(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
        <div className="flex items-center justify-between gap-4 border border-dashed p-4">
          <div className="flex min-w-0 items-center gap-3">
            <FileArchive className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{file?.name ?? t("guardrailPackage.chooseFile")}</p>
              <p className="text-xs text-muted-foreground">{t("guardrailPackage.dropHint")}</p>
            </div>
          </div>
          <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>{file ? t("guardrailPackage.chooseAnother") : t("guardrailPackage.chooseFile")}</Button>
        </div>
        {file ? <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label={t("guardrailPackage.importTitle")}>
          {STEPS.map(step => <li key={step} className="flex items-center gap-2" aria-current={active(step) ? "step" : undefined}>
            {active(step) ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : done(step) ? <Check className="size-4 text-[var(--success)]" /> : <Circle className="size-4 text-muted-foreground" />}
            <span className={done(step) || active(step) ? "" : "text-muted-foreground"}>{t(`guardrailPackage.step${step[0]!.toUpperCase()}${step.slice(1)}`)}</span>
          </li>)}
        </ol> : <InfoNotice>{t("guardrailPackage.noProductionTesting")}</InfoNotice>}
        {upload.error ? <ErrorNotice error={upload.error} /> : null}
        {preview ? <PackageSummary preview={preview} language={i18n.language} /> : null}
        {importing.error ? <ErrorNotice error={importing.error} /> : null}
      </div>
    </EntitySheet>
  );
}

function PackageSummary({ preview, language }: { preview: PackagePreview; language: string }) {
  const { t } = useTranslation();
  return <div className="space-y-4">
    <dl className="grid grid-cols-2 gap-4 border p-4 text-sm">
      <div><dt className="text-xs text-muted-foreground">{t("guardrailPackage.source")}</dt><dd className="mt-1 font-medium">{preview.source.name} <span className="font-mono text-xs text-muted-foreground">({preview.source.id})</span></dd>
        <dd className="mt-1 text-xs text-muted-foreground">{t("guardrailPackage.signedBy", { keyId: preview.keyId })} · {t("guardrailPackage.exportedAt", { time: new Date(preview.exportedAt).toLocaleString(language) })}</dd></div>
      <div><dt className="text-xs text-muted-foreground">{t("guardrailPackage.guardrail")}</dt><dd className="mt-1 font-medium">{preview.guardrail.name} <span className="font-mono text-xs text-muted-foreground">({preview.guardrail.id})</span></dd>
        <dd className="mt-1 text-xs text-muted-foreground">{t(preview.guardrail.exists ? "guardrailPackage.existingGuardrail" : "guardrailPackage.newGuardrail")}</dd></div>
    </dl>
    {preview.blockers.length ? <div role="alert" className="space-y-1 border border-destructive/40 p-4 text-sm">
      <p className="font-medium text-destructive">{t("guardrailPackage.blocked")}</p>
      {preview.blockers.map(blocker => <p key={blocker.code} className="text-destructive/80">{blocker.message}</p>)}
    </div> : null}
    <Table>
      <TableHeader><TableRow>
        <TableHead>{t("guardrailPackage.version")}</TableHead><TableHead>{t("guardrailPackage.uatResult")}</TableHead>
        <TableHead>{t("guardrailPackage.state")}</TableHead><TableHead>{t("guardrailPackage.environment")}</TableHead>
      </TableRow></TableHeader>
      <TableBody>{preview.versions.map(item => <TableRow key={item.version}>
        <TableCell><div className="flex flex-col items-start gap-1"><span className="whitespace-nowrap font-mono text-sm">{item.version}</span>{item.version === preview.recommendedVersion ? <Badge variant="outline" className="whitespace-nowrap">{t("guardrailPackage.recommended")}</Badge> : null}</div></TableCell>
        <TableCell><div className="flex flex-col items-start gap-1"><StateBadge state="passed" />
          <span className="text-xs text-muted-foreground">{typeof item.evidence.metrics.total === "number" ? `${t("guardrailPackage.passedCases", { passed: item.evidence.metrics.passed ?? 0, total: item.evidence.metrics.total })} · ` : ""}{t("guardrailPackage.testedAt", { time: new Date(item.evidence.testedAt).toLocaleString(language) })}</span></div></TableCell>
        <TableCell className="whitespace-nowrap"><StateBadge state={item.state === "new" ? "ready" : item.state === "existing" ? "active" : "failed"} label={t(`guardrailPackage.state${item.state === "new" ? "New" : item.state === "existing" ? "Existing" : "Conflict"}`)} /></TableCell>
        <TableCell><EnvironmentStatus check={item.environment} /></TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </div>;
}

/** Runner load-check verdict with the reasons a pool rejected the content. */
export function EnvironmentStatus({ check }: { check: EnvironmentCheck | null | undefined }) {
  const { t } = useTranslation();
  if (!check) return <span className="text-sm text-muted-foreground">{t("guardrailPackage.neverChecked")}</span>;
  const label = t(check.status === "compatible" ? "guardrailPackage.envCompatible" : check.status === "missing" ? "guardrailPackage.envMissing" : "guardrailPackage.envPending");
  const rejected = check.pools.filter(pool => !pool.admitted && !pool.unavailable);
  return <div className="flex flex-col items-start gap-1">
    <span className="whitespace-nowrap"><StateBadge state={check.status === "compatible" ? "ready" : check.status === "missing" ? "failed" : "unknown"} label={label} /></span>
    {rejected.map(pool => <span key={pool.poolId} className="text-xs text-destructive">{t("guardrailPackage.poolResult", { pool: pool.poolId, runner: pool.runnerId })}: {pool.reason}</span>)}
    {check.status === "pending" ? <span className="text-xs text-muted-foreground">{t("guardrailPackage.envPendingHint")}</span> : null}
  </div>;
}
