import { useRef, useState, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Circle, FileArchive, LoaderCircle, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { queryKeys } from "@/features/query-keys";
import { importGuardrailPackage, uploadGuardrailPackage, type EnvironmentCheck, type PackagePreview } from "@/lib/controller-api";
import { EntitySheet } from "./entity-sheet";
import { ErrorNotice, InfoNotice, StateBadge } from "./product-shell";
import { useDeploymentCapabilities } from "@/lib/deployment";
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
    mutationFn: (value: PackagePreview) => importGuardrailPackage(value.packageId, { restoreDeleted: value.guardrail.deleted }),
    onSuccess: async result => {
      if (result.restored) {
        // A restoration starts a new operational lifetime, even though the ID is unchanged.
        await queryClient.cancelQueries({ queryKey: queryKeys.validationRuns(result.guardrailId) });
        queryClient.removeQueries({ queryKey: queryKeys.validationRuns(result.guardrailId) });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.guardrails }),
        queryClient.invalidateQueries({ queryKey: queryKeys.guardrail(result.guardrailId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.guardrailVersions(result.guardrailId) }),
        // Policy versions arrived with it.
        queryClient.invalidateQueries({ queryKey: queryKeys.policies }),
        ...(result.restored ? [
          queryClient.invalidateQueries({ queryKey: queryKeys.allValidationRuns }),
          queryClient.invalidateQueries({ queryKey: queryKeys.runtimeEvents }),
          queryClient.invalidateQueries({ queryKey: queryKeys.metrics }),
          queryClient.invalidateQueries({ queryKey: queryKeys.auditEvents }),
        ] : []),
      ]);
      toast.success(t(result.restored ? "guardrailPackage.restored" : "guardrailPackage.imported", { imported: result.imported.length, existing: result.existing.length, policies: result.policies.imported.length }));
      onClose();
      void navigate({ to: "/guardrails/$guardrailId", params: { guardrailId: result.guardrailId }, search: { tab: "immutable" } });
    },
  });
  const busy = upload.isPending || importing.isPending;
  // Import needs trusted sources configured; the entry stays visible either way.
  const capabilities = useDeploymentCapabilities();
  const unavailable = capabilities.known && !capabilities.packageImport.available;
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
        <Button disabled={!preview || busy || preview.blockers.length > 0 || (fresh.length === 0 && !preview.guardrail.deleted)} onClick={() => { if (preview) importing.mutate(preview); }}>
          {importing.isPending ? <LoaderCircle className="animate-spin" /> : <Upload />}
          {importing.isPending ? t("guardrailPackage.importing") : !preview || preview.blockers.length > 0 ? t("guardrailPackage.import")
            : preview.guardrail.deleted ? t("guardrailPackage.restoreAndImport") : fresh.length === 0 ? t("guardrailPackage.nothingToImport")
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
          <Button variant="outline" disabled={busy || unavailable} onClick={() => input.current?.click()}>{file ? t("guardrailPackage.chooseAnother") : t("guardrailPackage.chooseFile")}</Button>
        </div>
        {file ? <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label={t("guardrailPackage.importTitle")}>
          {STEPS.map(step => <li key={step} className="flex items-center gap-2" aria-current={active(step) ? "step" : undefined}>
            {active(step) ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> : done(step) ? <Check className="size-4 text-[var(--success)]" /> : <Circle className="size-4 text-muted-foreground" />}
            <span className={done(step) || active(step) ? "" : "text-muted-foreground"}>{t(`guardrailPackage.step${step[0]!.toUpperCase()}${step.slice(1)}`)}</span>
          </li>)}
        </ol> : <InfoNotice>{t(unavailable ? "guardrailPackage.importUnavailable" : "guardrailPackage.noProductionTesting")}</InfoNotice>}
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
        <dd className="mt-1 text-xs text-muted-foreground">{t(preview.guardrail.deleted ? "guardrailPackage.deletedGuardrail" : preview.guardrail.exists ? "guardrailPackage.existingGuardrail" : "guardrailPackage.newGuardrail")}</dd></div>
    </dl>
    {preview.guardrail.deleted && !preview.blockers.length ? <InfoNotice>{t("guardrailPackage.restoreNotice")}</InfoNotice> : null}
    {preview.blockers.length ? <div role="alert" className="space-y-1 border border-destructive/40 p-4 text-sm">
      <p className="font-medium text-destructive">{t("guardrailPackage.blocked")}</p>
      {preview.blockers.map((blocker, index) => <p key={`${blocker.code}-${index}`} className="text-destructive/80">{blocker.message}</p>)}
    </div> : null}
    <PolicyLeaves policies={preview.policies} />
    <h3 className="text-sm font-semibold">{t("guardrailPackage.versionsHeading")}</h3>
    <Table>
      <TableHeader><TableRow>
        <TableHead>{t("guardrailPackage.version")}</TableHead><TableHead>{t("guardrailPackage.testSuite")}</TableHead>
        <TableHead>{t("guardrailPackage.state")}</TableHead><TableHead>{t("guardrailPackage.environment")}</TableHead>
      </TableRow></TableHeader>
      <TableBody>{preview.versions.map(item => <TableRow key={item.version}>
        <TableCell><div className="flex flex-col items-start gap-1"><span className="whitespace-nowrap font-mono text-sm">{item.version}</span></div></TableCell>
        <TableCell className="whitespace-nowrap text-sm">{t("guardrailPackage.testSuiteCases", { count: item.testSuite.total })}</TableCell>
        <TableCell className="whitespace-nowrap"><StateBadge state={item.state === "new" ? "ready" : item.state === "existing" ? preview.guardrail.deleted ? "unpublished" : "active" : "failed"} label={t(`guardrailPackage.state${item.state === "new" ? "New" : item.state === "existing" ? preview.guardrail.deleted ? "Retained" : "Existing" : "Conflict"}`)} /></TableCell>
        <TableCell><EnvironmentStatus check={item.environment} /></TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </div>;
}

/** The package's leaves: Policy versions that need adding, or that conflict, listed; the rest counted. */
function PolicyLeaves({ policies }: { policies: PackagePreview["policies"] }) {
  const { t } = useTranslation();
  const listed = policies.filter(item => item.state !== "existing");
  const existing = policies.length - listed.length;
  return <section className="space-y-2">
    <h3 className="text-sm font-semibold">{t("guardrailPackage.policiesHeading")}</h3>
    <p className="text-xs text-muted-foreground">{t("guardrailPackage.policiesDescription")}</p>
    {listed.length ? <Table>
      <TableHeader><TableRow>
        <TableHead>{t("guardrailPackage.policy")}</TableHead><TableHead>{t("guardrailPackage.policyKind")}</TableHead><TableHead>{t("guardrailPackage.state")}</TableHead>
      </TableRow></TableHeader>
      <TableBody>{listed.map(item => <TableRow key={`${item.id}@${item.version}`}>
        <TableCell className="whitespace-normal"><p className="text-sm font-medium">{item.name}</p><code className="break-all text-xs text-muted-foreground">{item.id}@{item.version}</code></TableCell>
        <TableCell className="whitespace-nowrap text-sm">{t(`guardrailPackage.policyKinds.${item.kind}`)}</TableCell>
        <TableCell className="whitespace-nowrap"><StateBadge state={item.state === "new" ? "ready" : "failed"} label={t(item.state === "new" ? "guardrailPackage.stateNew" : "guardrailPackage.stateConflict")} /></TableCell>
      </TableRow>)}</TableBody>
    </Table> : null}
    {existing ? <p className="text-xs text-muted-foreground">{t("guardrailPackage.policiesExisting", { count: existing })}</p> : null}
  </section>;
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
