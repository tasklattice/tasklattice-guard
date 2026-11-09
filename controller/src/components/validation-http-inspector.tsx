import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { toast } from "./ui/notifications";
import { SyntaxCode } from "./syntax-code";
import { bodyFormat, headers, record, text, type EvidenceRecord } from "@/lib/validation-evidence";

const key = "modelSettings.evidence.";
function requestPath(value: unknown) {
  const url = text(value);
  try { const parsed = new URL(url); return parsed.pathname + parsed.search; } catch { return url; }
}
export function ValidationHttpInspector({ calls, output }: { calls: EvidenceRecord[]; output: EvidenceRecord }) {
  const { t } = useTranslation();
  const [selectedIndex, setSelectedIndex] = useState(calls.length - 1);
  const selected = calls[selectedIndex] ?? calls.at(-1);
  const request = record(selected?.request);
  const response = record(selected?.response);
  const error = record(selected?.error);
  return <div className="space-y-3">
    <p className="text-xs leading-5 text-muted-foreground">{t(key + "redacted")}</p>
    {!Array.isArray(output.model_exchanges) ? <p className="border-l-2 border-amber-500 bg-muted/30 p-3 text-sm leading-6">{t(key + "legacy")}</p> : null}
    {Number(output.dropped_model_exchanges) > 0 ? <p role="status" className="text-sm">{t(key + "dropped", { count: Number(output.dropped_model_exchanges) })}</p> : null}
    {selected ? <div className="grid grid-cols-[14rem_minmax(0,1fr)] border">
      <nav aria-label={t(key + "callList")} className="border-r bg-muted/10">
        {calls.map((call, i) => <button key={i} type="button" aria-current={i === selectedIndex ? "true" : undefined} aria-label={`${t(key + "exchange", { count: i + 1 })} · ${text(record(call.request).method)} ${requestPath(record(call.request).url)} · ${call.response ? `HTTP ${text(record(call.response).status)}` : t(key + "noResponse")}`}
          className={`block w-full border-b border-l-2 px-3 py-3 text-left text-xs focus-visible:outline-2 focus-visible:outline-ring ${i === selectedIndex ? "border-l-primary bg-muted" : "border-l-transparent hover:bg-muted/50"}`}
          onClick={() => setSelectedIndex(i)}>
          <span className="flex justify-between gap-2"><span className="font-semibold">{i + 1}. {text(record(call.request).method)}</span><span className={Number(record(call.response).status) >= 400 || !call.response ? "text-destructive" : "text-muted-foreground"}>{call.response ? `HTTP ${text(record(call.response).status)}` : t(key + "noResponseShort")}</span></span>
          <span className="my-2 block font-mono leading-5 [overflow-wrap:anywhere]" title={text(record(call.request).url)}>{requestPath(record(call.request).url)}</span>
          {typeof call.duration_ms === "number" ? <span className="tabular-nums text-muted-foreground">{call.duration_ms} ms</span> : null}
        </button>)}
      </nav>
      <div className="min-w-0">
        <div className="space-y-2 border-b px-4 py-3 text-xs">
          <p className="font-mono leading-5 [overflow-wrap:anywhere]">{text(request.method)} {text(request.url)}</p>
          <p className="tabular-nums text-muted-foreground">{selected.response ? `HTTP ${text(response.status)}` : t(key + "noResponse")}{typeof selected.duration_ms === "number" ? ` · ${selected.duration_ms} ms` : ""}{selected.started_at ? ` · ${text(selected.started_at)}` : ""}</p>
          {selected.error ? <p className="leading-5 text-destructive [overflow-wrap:anywhere]">{[text(error.type), text(error.message)].filter(Boolean).join(": ") || text(selected.error)}</p> : null}
        </div>
        <Tabs defaultValue="response">
          <TabsList aria-label={t(key + "httpDetails")}>
            <TabsTrigger value="headers">{t(key + "headers")}</TabsTrigger>
            <TabsTrigger value="payload">{t(key + "payload")}</TabsTrigger>
            <TabsTrigger value="response">{t(key + "response")}</TabsTrigger>
          </TabsList>
          <TabsContent value="headers" className="space-y-5 !p-4"><HeaderTable title={t(key + "requestHeaders")} value={request.headers} /><HeaderTable title={t(key + "responseHeaders")} value={response.headers} /></TabsContent>
          <TabsContent value="payload" className="!p-4"><BodyPart title={t(key + "payload")} value={selected.request} /></TabsContent>
          <TabsContent value="response" className="!p-4"><BodyPart title={t(key + "response")} value={selected.response} /></TabsContent>
        </Tabs>
      </div>
    </div> : <p className="py-5 text-sm text-muted-foreground">{t(key + "noCalls")}</p>}
  </div>;
}
function HeaderTable({ title, value }: { title: string; value: unknown }) {
  const { t } = useTranslation();
  const pairs = headers(value);
  return <section><h4 className="mb-2 text-sm font-semibold">{title}</h4>{pairs.length ? <table className="w-full table-fixed text-left text-xs"><colgroup><col className="w-1/3" /><col /></colgroup><thead className="sr-only"><tr><th>{t(key + "headerName")}</th><th>{t(key + "value")}</th></tr></thead><tbody>{pairs.map(([name, value], i) => <tr key={i} className="border-b"><th scope="row" className="py-2 pr-4 align-top font-mono font-normal [overflow-wrap:anywhere]">{name}</th><td className="py-2 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</td></tr>)}</tbody></table> : <p className="text-sm text-muted-foreground">{t(key + "noHeaders")}</p>}</section>;
}
function BodyPart({ title, value }: { title: string; value: unknown }) {
  const { t } = useTranslation();
  const part = record(value);
  const body = text(part.body);
  const formatted = bodyFormat(part.body);
  if (value == null) return <p className="py-2 text-sm text-muted-foreground">{t(key + "noResponse")}</p>;
  return <section className="min-w-0">
    <div className="mb-2 flex items-center justify-between"><span className="text-xs text-muted-foreground">{formatted.language === "json" ? "JSON" : t(key + "text")}</span>
      <Button variant="ghost" size="sm" disabled={!body} onClick={async () => {
        try { await navigator.clipboard.writeText(body); toast.success(t(key + "copied")); }
        catch { toast.error(t(key + "copyFailed")); }
      }}><Copy />{t(key + "copyBody", { part: title })}</Button>
    </div>
    {part.body_truncated ? <p className="mb-3 text-sm">{t(key + "truncated")}</p> : null}
    {body ? <SyntaxCode language={formatted.language} label={title} content={formatted.content} className="max-h-[32rem] whitespace-pre-wrap [overflow-wrap:anywhere]" /> : <p className="py-3 text-sm text-muted-foreground">{t(key + "emptyBody")}</p>}
  </section>;
}
