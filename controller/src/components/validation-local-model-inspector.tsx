import { useState } from "react";
import { useTranslation } from "react-i18next";
import { record, text, type EvidenceRecord } from "@/lib/validation-evidence";
import { SyntaxCode } from "./syntax-code";
import { Button } from "./ui/button";

const key = "modelSettings.evidence.";

export function ValidationLocalModelInspector({ calls }: { calls: EvidenceRecord[] }) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(calls.length - 1);
  const call = calls[index] ?? calls.at(-1);
  if (!call) return null;

  const error = record(call.error);
  const errorMessage = [text(error.type), text(error.message)].filter(Boolean).join(": ");
  const sections = [
    { title: t(key + "localModelInput"), value: call.input, truncated: call.input_truncated },
    { title: t(key + "localModelOutput"), value: errorMessage && call.output === null ? undefined : call.output, truncated: call.output_truncated },
  ];

  return <div className="min-w-0 space-y-4">
    {calls.length > 1 ? <div role="group" aria-label={t(key + "localModelCalls")} className="flex flex-wrap gap-2">
      {calls.map((_, i) => <Button key={i} type="button" variant={i === index ? "outline" : "ghost"}
        aria-pressed={i === index} onClick={() => setIndex(i)}>{t(key + "exchange", { count: i + 1 })}</Button>)}
    </div> : null}
    {errorMessage ? <p className="border-l-2 border-destructive py-2 pl-3 text-sm text-destructive [overflow-wrap:anywhere]">{errorMessage}</p> : null}
    {sections.map(({ title, value, truncated }) => <section key={title} className="min-w-0">
      <h4 className="mb-2 text-sm font-semibold">{title}</h4>
      {truncated === true ? <p className="mb-2 text-sm text-muted-foreground">{t(key + "truncated")}</p> : null}
      {value === undefined
        ? <p className="text-sm text-muted-foreground">{t(key + "noLocalPayload")}</p>
        : <SyntaxCode language="json" label={title} content={JSON.stringify(value, null, 2)}
            className="max-h-80 whitespace-pre-wrap [overflow-wrap:anywhere]" />}
    </section>)}
  </div>;
}
