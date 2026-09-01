import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, FileText, FileUp, LoaderCircle, Sparkles, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorNotice, InfoNotice } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  analyzeComplianceDocuments,
  type ComplianceDocumentAnalysis,
  type Policy,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const MAX_FILES = 3;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = [".doc", ".docx", ".txt"];

export function ComplianceDocumentImport({
  available,
  analystProvider,
  analystModel,
  language,
  policies,
  resetKey,
  onApply,
}: {
  available: boolean;
  analystProvider?: string | null;
  analystModel?: string | null;
  language: "en" | "zh-CN";
  policies: Policy[];
  resetKey: number;
  onApply: (analysis: ComplianceDocumentAnalysis) => void;
}) {
  const { t, i18n } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [analysis, setAnalysis] = useState<ComplianceDocumentAnalysis | null>(null);
  const [applied, setApplied] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const analyze = useMutation({
    mutationFn: () => analyzeComplianceDocuments(files, language),
    onSuccess: (result) => {
      setAnalysis(result);
      setApplied(false);
      setSelectionError("");
    },
  });

  useEffect(() => {
    setFiles([]);
    setAnalysis(null);
    setApplied(false);
    setSelectionError("");
    analyze.reset();
    if (inputRef.current) inputRef.current.value = "";
    // resetKey intentionally owns the lifecycle of this draft-only import.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  function selectFiles(selected: File[]) {
    const next = [...files];
    for (const file of selected) {
      const extension = file.name.slice(file.name.lastIndexOf(".")).toLocaleLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(extension)) {
        setSelectionError(t("guardrailWizard.documentUnsupported", { name: file.name }));
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setSelectionError(t("guardrailWizard.documentTooLarge", { name: file.name }));
        return;
      }
      if (!next.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) next.push(file);
    }
    if (next.length > MAX_FILES) {
      setSelectionError(t("guardrailWizard.documentLimit", { count: MAX_FILES }));
      return;
    }
    if (next.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) {
      setSelectionError(t("guardrailWizard.documentTotalTooLarge"));
      return;
    }
    setFiles(next);
    setAnalysis(null);
    setApplied(false);
    setSelectionError("");
    analyze.reset();
  }

  function removeFile(file: File) {
    setFiles((current) => current.filter((item) => item !== file));
    setAnalysis(null);
    setApplied(false);
    setSelectionError("");
    analyze.reset();
  }

  const policyNames = new Map(policies.map((policy) => [policy.id, policy.name]));
  const analyst = [analystProvider, analystModel].filter(Boolean).join(" · ");

  return (
    <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="compliance-document-title">
      <header className="flex flex-col gap-3 border-b bg-muted/20 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><FileText className="size-4" /></span>
            <div>
              <h4 id="compliance-document-title" className="text-sm font-semibold">{t("guardrailWizard.documentImportTitle")}</h4>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.documentImportDescription")}</p>
            </div>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          disabled={!available || files.length >= MAX_FILES || analyze.isPending}
          onClick={() => inputRef.current?.click()}
        >
          <FileUp />{t(files.length ? "guardrailWizard.documentAdd" : "guardrailWizard.documentChoose")}
        </Button>
        <input
          ref={inputRef}
          hidden
          type="file"
          multiple
          accept=".doc,.docx,.txt,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          onChange={(event) => {
            selectFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </header>

      <div className="space-y-4 p-4">
        {!available ? <InfoNotice title={t("guardrailWizard.documentUnavailable")}>{t("guardrailWizard.documentUnavailableDescription")}</InfoNotice> : null}
        {available && !files.length ? (
          <div className="rounded-lg border border-dashed p-5 text-center">
            <p className="text-sm font-medium">{t("guardrailWizard.documentEmpty")}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("guardrailWizard.documentFormats", { count: MAX_FILES })}</p>
          </div>
        ) : null}

        {files.length ? (
          <div className="overflow-hidden rounded-lg border" aria-label={t("guardrailWizard.documentSelectedFiles")}>
            <div className="flex items-center justify-between gap-3 border-b bg-muted/20 px-3 py-2">
              <strong className="text-xs font-medium">{t("guardrailWizard.documentSelectedCount", { count: files.length })}</strong>
              <span className="text-[11px] text-muted-foreground">{formatBytes(files.reduce((total, file) => total + file.size, 0), i18n.language)} / 10 MB</span>
            </div>
            <div className="divide-y">
              {files.map((file) => (
                <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-xs font-medium">{file.name}</strong>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{formatBytes(file.size, i18n.language)}</span>
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-11"
                    disabled={analyze.isPending}
                    aria-label={t("guardrailWizard.documentRemove", { name: file.name })}
                    onClick={() => removeFile(file)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {selectionError ? <p role="alert" className="text-sm text-destructive">{selectionError}</p> : null}
        {analyze.error ? <ErrorNotice error={analyze.error} /> : null}

        {files.length && !analysis ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-muted-foreground">{t("guardrailWizard.documentPrivacy", { analyst })}</p>
            <Button type="button" className="min-h-11" disabled={!available || analyze.isPending} onClick={() => analyze.mutate()}>
              {analyze.isPending ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              {t(analyze.isPending ? "guardrailWizard.documentAnalyzing" : "guardrailWizard.documentAnalyze", { count: files.length })}
            </Button>
          </div>
        ) : null}

        {analysis ? (
          <section className="overflow-hidden rounded-lg border" aria-live="polite">
            <header className="flex flex-wrap items-start justify-between gap-3 border-b bg-muted/20 p-3">
              <div>
                <h5 className="text-sm font-semibold">{t("guardrailWizard.documentDraftReady")}</h5>
                <p className="mt-1 text-xs text-muted-foreground">{t("guardrailWizard.documentDraftSummary", { requirements: analysis.requirements.length, policies: analysis.recommended_policy_ids.length })}</p>
              </div>
              <Badge variant="outline" className={cn(applied && "border-emerald-200 bg-emerald-50 text-emerald-700")}>
                {applied ? <Check /> : <Sparkles />}{t(applied ? "guardrailWizard.documentApplied" : "guardrailWizard.documentDraft")}
              </Badge>
            </header>
            <div className="space-y-4 p-4">
              <div>
                <p className="text-xs font-medium text-muted-foreground">{t("guardrailWizard.documentPurpose")}</p>
                <p className="mt-1 text-sm leading-6">{analysis.summary}</p>
              </div>

              {analysis.recommended_policy_ids.length ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">{t("guardrailWizard.documentRecommendedPolicies")}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {analysis.recommended_policy_ids.map((id) => <Badge key={id} variant="secondary">{policyNames.get(id) ?? id}</Badge>)}
                  </div>
                </div>
              ) : null}

              <details className="group rounded-lg border" open>
                <summary className="min-h-11 cursor-pointer list-none px-3 py-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  {t("guardrailWizard.documentRequirements", { count: analysis.requirements.length })}
                </summary>
                <div className="divide-y border-t">
                  {analysis.requirements.map((requirement, index) => (
                    <article key={`${requirement.title}-${index}`} className="p-3">
                      <div className="flex flex-wrap items-center gap-2"><strong className="text-xs">{requirement.title}</strong><Badge variant="outline">{t(`guardrailWizard.documentEffects.${requirement.effect}`)}</Badge></div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{requirement.description}</p>
                      <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">{requirement.source_refs.join(" · ")}</p>
                    </article>
                  ))}
                </div>
              </details>

              {analysis.review_notes.length ? (
                <InfoNotice title={t("guardrailWizard.documentReviewNotes")}>{analysis.review_notes.join(" · ")}</InfoNotice>
              ) : null}

              <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-5 text-muted-foreground">{t("guardrailWizard.documentApplyDescription")}</p>
                <Button type="button" className="min-h-11" disabled={applied} onClick={() => { onApply(analysis); setApplied(true); }}>
                  <Check />{t(applied ? "guardrailWizard.documentApplied" : "guardrailWizard.documentApply")}
                </Button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function formatBytes(value: number, locale: string) {
  if (value < 1024) return `${value} B`;
  if (value >= 1024 * 1024) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / (1024 * 1024))} MB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1024)} KB`;
}
