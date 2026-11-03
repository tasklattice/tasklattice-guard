import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { ErrorNotice } from "./product-shell";
import { LogBody } from "./runtime-content-panel";
import { downloadLogFile } from "@/lib/http-log-content";
import type { ModelHttpExchange, RuntimeLogEntry } from "@/lib/api-types";

export function RuntimeModelEvidence({ entry, canViewContent, loadContent }: {
  entry: RuntimeLogEntry; canViewContent: boolean; loadContent?: (signal: AbortSignal) => Promise<RuntimeLogEntry>;
}) {
  const { t } = useTranslation();
  const [exchanges, setExchanges] = useState(entry.model_exchanges ?? null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  if (!entry.model_evidence_status && !exchanges?.length) return null;
  const key = "logs.diagnostics.modelEvidence.";
  async function show() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (exchanges || !loadContent) return;
    const controller = new AbortController(); abort.current = controller;
    setLoading(true); setError(null);
    try { const detail = await loadContent(controller.signal); if (!controller.signal.aborted) setExchanges(detail.model_exchanges ?? []); }
    catch (failure) { if (!controller.signal.aborted) setError(failure); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  return <section className="border-t pt-3" aria-label={t(key + "title")}>
    <h4 className="text-sm font-semibold">{t(key + "title")}</h4>
    {entry.model_evidence_status !== "captured" && !exchanges?.length
      ? <p className="mt-2 text-sm leading-5">{t(key + (entry.model_evidence_status ?? "not_recorded"), { defaultValue: t(key + "not_recorded") })}</p>
      : !canViewContent ? <p className="mt-2 text-sm">{t("logs.restrictedContentDescription")}</p>
      : <>
        <p className="mt-2 text-sm leading-5">{t(key + "description")}</p>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="outline" aria-expanded={open} onClick={() => void show()}>{t(key + (open ? "hide" : "show"), { count: entry.model_evidence_count ?? exchanges?.length ?? 0 })}</Button>
          {exchanges?.length ? <Button variant="ghost" onClick={() => downloadLogFile(new TextEncoder().encode(JSON.stringify(exchanges, null, 2)), `${entry.id}-model-evidence.json`, "application/json")}>{t(key + "download")}</Button> : null}
        </div>
        {open && loading ? <p className="mt-3 text-sm" role="status">{t("logs.loadingDetail")}</p> : null}
        {open && error ? <div className="mt-3"><ErrorNotice error={error} /><Button variant="ghost" onClick={() => { setOpen(false); setError(null); }}>{t("common.close")}</Button></div> : null}
        {open && exchanges?.length === 0 ? <p className="mt-3 text-sm">{t(key + "not_recorded")}</p> : null}
        {open ? exchanges?.map((exchange, index) => <article key={`${exchange.modelCallId}:${index}`} className="mt-4 border-t pt-4">
          <p className="break-all text-sm font-medium">{exchange.provider} · {exchange.model}</p>
          <p className="mt-1 break-all font-mono text-xs">Model Call ID: {exchange.modelCallId} · {exchange.result}</p>
          {exchange.request.sent === false ? <p className="mt-2 text-sm">{t(key + "notSent")}</p> : null}
          <ExchangePart title={t(key + "request")} heading={`${exchange.request.method} ${exchange.request.url}`} part={exchange.request} />
          {exchange.response ? <>
            {exchange.response.bodyComplete === false ? <p className="mt-3 text-sm">{t(key + "incompleteResponse")}</p> : null}
            <ExchangePart title={t(key + "response")} heading={`HTTP ${exchange.response.status}`} part={exchange.response} />
          </> : <p className="mt-3 text-sm">{t(key + "noResponse")}</p>}
        </article>) : null}
      </>}
  </section>;
}

function ExchangePart({ title, heading, part }: { title: string; heading: string; part: ModelHttpExchange["request"] | NonNullable<ModelHttpExchange["response"]> }) {
  let body = "";
  try { body = new TextDecoder().decode(Uint8Array.from(atob(part.bodyBase64), c => c.charCodeAt(0))); } catch { /* Older evidence may not have a body. */ }
  return <details className="mt-3 border"><summary className="cursor-pointer break-all px-3 py-3 text-sm"><strong>{title}</strong> · {heading} · {part.bodyBytes} B</summary>
    <pre className="overflow-auto whitespace-pre-wrap break-all border-y px-4 py-3 font-mono text-xs leading-5">{part.headers.map(([name, value]) => `${name}: ${value}`).join("\n")}</pre>
    <LogBody body={body} />
  </details>;
}

/** Report bodies already follow the validation report's content permissions. */
export function ModelValidationEvidence({ id, outputContent }: { id: string; outputContent: string }) {
  let exchanges: ModelHttpExchange[] = [];
  try { const payload = JSON.parse(outputContent); if (Array.isArray(payload.model_http_evidence)) exchanges = payload.model_http_evidence; } catch { /* Non-JSON test outputs remain ordinary output. */ }
  return exchanges.length ? <RuntimeModelEvidence canViewContent entry={{ id, model_exchanges: exchanges, model_evidence_status: "captured", model_evidence_count: exchanges.length } as RuntimeLogEntry} /> : null;
}

/** The evidence panel renders this field; copying/downloading still uses the full report. */
export function validationOutputPreview(outputContent: string): string {
  try {
    const payload = JSON.parse(outputContent);
    if (!Array.isArray(payload.model_http_evidence)) return outputContent;
    delete payload.model_http_evidence;
    return JSON.stringify(payload, null, 2);
  } catch { return outputContent; }
}

export function validationHttpExchange(evidence?: string | null): ModelHttpExchange | null {
  try {
    const value = JSON.parse(evidence ?? "null");
    return value && typeof value.modelCallId === "string" && typeof value.request?.bodyBase64 === "string" && Array.isArray(value.request?.headers) ? value : null;
  } catch { return null; }
}
