import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileSearch, X } from "lucide-react";
import { Button } from "./ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "./ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { StateBadge } from "./product-shell";
import { ValidationResultSummary, EvidenceField } from "./validation-result-summary";
import { ValidationHttpInspector } from "./validation-http-inspector";
import { downloadLogFile } from "@/lib/http-log-content";
import { exchanges, parse, record, resultEvidence, text, validationEvidenceDocument, type ValidationCheck } from "@/lib/validation-evidence";

export { validationEvidenceDocument } from "@/lib/validation-evidence";
const key = "modelSettings.evidence.";

export function ValidationEvidenceSheet({ check, subject, label }: { check: ValidationCheck; subject: string; label: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const cases = check.cases ?? [];
  const selected = cases.find(item => item.id === selectedId) ?? cases.find(item => !item.passed) ?? cases[0];
  const output = parse(selected?.outputContent);
  const context = record(output.validation_context);
  const build = record(context.runner_build);
  const calls = exchanges(output);
  const evaluations = resultEvidence(output).evaluations;
  const formal = text(context.binding_id).startsWith("automated_reasoning.") || check.id.startsWith("probe:automated_reasoning.");
  const caseName = (id: string) => t(key + (id.split(":").at(-1) === "safe" ? formal ? "validSample" : "safeSample" : id.split(":").at(-1) === "unsafe" ? formal ? "invalidSample" : "unsafeSample" : "sample"), { id });
  const passed = check.status === "passed";
  const evidenceLabel = t(key + (passed ? "passedEvidence" : "failedEvidence"));
  const badge = <StateBadge state={check.status === "passed" ? "ready" : "failed"} label={label} />;
  return <Sheet open={open} onOpenChange={value => { setOpen(value); if (value) setSelectedId(undefined); }}>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <SheetTrigger asChild><Button variant="ghost" size="sm"
        className={`h-8 shrink-0 gap-1.5 !px-2 hover:underline ${passed ? "!bg-[var(--notice-success)] !text-[var(--success)]" : "!bg-[var(--notice-danger)] !text-destructive"}`}
        aria-label={`${evidenceLabel} · ${subject}`}><FileSearch className="size-4" />{evidenceLabel}</Button></SheetTrigger>
      {check.latencyMs != null ? <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{check.latencyMs} ms</span> : null}
    </div>
    <SheetContent showCloseButton={false} className="!w-[min(72rem,calc(100vw-3rem))] !max-w-none gap-0">
      <SheetHeader className="shrink-0 border-b px-6 py-4 pr-16">
        <SheetTitle className="text-xl">{t(key + "title")}</SheetTitle>
        <SheetDescription className="mt-1 break-words">{subject}</SheetDescription>
        <div className="mt-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">{badge}<span className="text-sm tabular-nums">{t(key + "sampleCount", { passed: cases.filter(item => item.passed).length, total: cases.length })}</span></div>
          <Button variant="outline" size="sm" title={t(key + "exportHint")} onClick={() => {
            const content = JSON.stringify(validationEvidenceDocument(check, subject), null, 2);
            downloadLogFile(new TextEncoder().encode(content), `validation-${check.id.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`, "application/json");
          }}><Download />{t(key + "export")}</Button>
        </div>
        <SheetClose asChild><Button variant="ghost" size="icon" className="absolute right-3 top-3" aria-label={t("common.close")}><X /></Button></SheetClose>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {cases.length && selected ? <>
          <nav aria-label={t(key + "samples")} className="flex flex-wrap gap-2 border-b px-6 py-3">
            {cases.map(item => <button key={item.id} type="button" aria-current={item.id === selected.id ? "true" : undefined}
              className={`flex items-center gap-3 border-b-2 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring ${item.id === selected.id ? "border-primary bg-muted" : "border-transparent hover:bg-muted/40"}`}
              onClick={() => setSelectedId(item.id)}>
              <span className="font-medium">{caseName(item.id)}</span><StateBadge state={item.passed ? "ready" : "failed"} label={t(key + (item.passed ? "passed" : "failed"))} />
            </button>)}
          </nav>
          <div key={selected.id} className="min-w-0 px-6 pb-6">
            <details className="border-b py-3 text-sm">
              <summary className="w-fit cursor-pointer text-muted-foreground">{t(key + "execution")}</summary>
              <dl className="mt-4 grid grid-cols-3 gap-x-6 gap-y-4">
                <EvidenceField label={t(key + "recordedAt")} value={context.recorded_at} />
                <EvidenceField label={t(key + "runner")} value={context.runner_id} />
                <EvidenceField label={t(key + "build")} value={[text(build.version), text(build.commit), build.dirty === true ? "dirty" : ""].filter(Boolean).join(" · ")} />
                <EvidenceField label={t(key + "model")} value={context.model} />
                <EvidenceField label={t(key + "profile")} value={context.profile} />
                <EvidenceField label={t(key + "endpoint")} value={context.base_url} />
                {evaluations.map((item, index) => <div key={index} className="col-span-3 grid grid-cols-3 gap-6">
                  <EvidenceField label={t(key + "revision")} value={item.data.question_revision ?? item.data.review_revision} />
                  <EvidenceField label={t(key + "routing")} value={record(record(item.data.model_metadata).routing).model ?? item.data.response_model} />
                </div>)}
              </dl>
              <p className="mt-4 whitespace-pre-wrap leading-6 [overflow-wrap:anywhere]">{check.message}</p>
              <p className="mt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">{selected.id}</p>
            </details>
            <Tabs defaultValue="result" className="mt-3">
              <TabsList aria-label={t(key + "views")}>
                <TabsTrigger value="result">{t(key + "result")}</TabsTrigger>
                <TabsTrigger value="calls">{t(key + "http")} ({calls.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="result" className="pt-4"><ValidationResultSummary sample={selected} output={output} /></TabsContent>
              <TabsContent value="calls" className="pt-4"><ValidationHttpInspector calls={calls} output={output} /></TabsContent>
            </Tabs>
          </div>
        </> : <div className="space-y-4 px-6 py-6"><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{check.message}</p><p className="text-muted-foreground">{t(key + "noSamples")}</p></div>}
      </div>
    </SheetContent>
  </Sheet>;
}
