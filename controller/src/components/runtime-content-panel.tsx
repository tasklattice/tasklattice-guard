import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/product-shell";
import type { RuntimeHttpRequest, RuntimeLogContentBlock } from "@/lib/api";
import { downloadLogFile, formattedJsonTokens, httpBodyBytes, httpRequestBytes } from "@/lib/http-log-content";

const PREVIEW_LIMIT = 64 * 1024;

export function LogBody({ body, truncated = false }: { body: string; truncated?: boolean }) {
  const { t } = useTranslation();
  const preview = body.slice(0, PREVIEW_LIMIT);
  const clipped = truncated || body.length > PREVIEW_LIMIT;
  const tokens = useMemo(() => clipped ? null : formattedJsonTokens(preview), [preview, clipped]);
  const colors = {
    key: "text-primary", string: "text-emerald-700 dark:text-emerald-400",
    number: "text-amber-700 dark:text-amber-400", literal: "text-rose-700 dark:text-rose-400",
    punctuation: "text-muted-foreground", space: "",
  };
  return <><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words px-4 py-4 font-mono text-xs leading-6 text-foreground"><code>{tokens
    ? tokens.map((token, index) => <span key={index} className={colors[token.kind]}>{token.text}</span>)
    : preview}</code></pre>{clipped ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t("logs.bodyPreviewLimited")}</p> : null}</>;
}

type Content = { blocks: RuntimeLogContentBlock[] | null; available: boolean; httpRequest?: RuntimeHttpRequest | null };

export function RuntimeContentPanel({ title, description, blocks, available, transformed = false, httpRequest, downloadId, collapsible = false, loadContent }: Content & {
  title: string; description: string; transformed?: boolean; downloadId?: string; collapsible?: boolean;
  loadContent?: (signal: AbortSignal) => Promise<Content>;
}) {
  const { t } = useTranslation();
  const contentId = useId();
  const [expanded, setExpanded] = useState(!collapsible);
  const [loaded, setLoaded] = useState<Content>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const pending = useRef<{ controller: AbortController; promise: Promise<Content> } | null>(null);
  useEffect(() => () => { pending.current?.controller.abort(); }, []);
  const content = loaded ?? { blocks, available, httpRequest };
  const ensureContent = (): Promise<Content> => {
    if (loaded || !loadContent || !available) return Promise.resolve(content);
    if (pending.current) return pending.current.promise;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const promise = loadContent(controller.signal).then(value => {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      setLoaded(value);
      return value;
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason);
      throw reason;
    }).finally(() => {
      if (pending.current?.controller === controller) pending.current = null;
      if (!controller.signal.aborted) setLoading(false);
    });
    pending.current = { controller, promise };
    return promise;
  };
  const toggle = () => {
    setExpanded(value => !value);
    if (!expanded) void ensureContent().catch(() => {});
  };
  const body = useMemo(() => {
    if (!expanded || !content.httpRequest) return null;
    // Decode only the visible prefix. Download still uses the full captured bytes.
    const base64Limit = 4 * Math.ceil(PREVIEW_LIMIT / 3);
    const encoded = content.httpRequest.bodyBase64;
    return { text: new TextDecoder().decode(httpBodyBytes({ ...content.httpRequest, bodyBase64: encoded.slice(0, base64Limit) })), truncated: encoded.length > base64Limit };
  }, [expanded, content.httpRequest]);
  const visibleBlocks = useMemo(() => {
    if (!expanded) return [];
    let remaining = PREVIEW_LIMIT;
    return (content.blocks ?? []).slice(0, 100).flatMap(block => {
      if (remaining <= 0) return [];
      const text = block.text.slice(0, remaining);
      remaining -= text.length;
      return [{ ...block, text, truncated: block.truncated || text.length < block.text.length }];
    });
  }, [expanded, content.blocks]);
  const canDownload = Boolean(downloadId && (content.httpRequest || content.blocks?.length || (loadContent && available && !loaded)));
  const download = async () => {
    try {
      const value = await ensureContent();
      const name = (downloadId ?? "request").replace(/[^a-z0-9_-]/gi, "_");
      if (value.httpRequest) downloadLogFile(httpRequestBytes(value.httpRequest), `${name}.http`, "application/octet-stream");
      else if (value.blocks?.length) downloadLogFile(new TextEncoder().encode(value.blocks.map(block => block.text).join("\n\n")), `${name}-body.txt`, "text/plain;charset=utf-8");
    } catch { /* The inline error offers retry for both expansion and download. */ }
  };
  return <section className="min-w-0 rounded-md border bg-card">
    <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1"><h4 className="text-sm font-semibold">{collapsible ? <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring" aria-expanded={expanded} aria-controls={contentId} onClick={toggle}><ChevronDown aria-hidden className={`size-4 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`} />{title}</button> : title}</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">{content.httpRequest ? t("logs.httpBodyDescription") : description}</p></div>
      {canDownload ? <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={loading} onClick={() => void download()}><Download className="size-4" />{t(content.httpRequest ? "logs.downloadHttpRequest" : loadContent && !loaded ? "logs.downloadContent" : "logs.downloadBody")}</Button> : null}
    </header>
    {loading ? <p role="status" className="px-4 pb-3 text-xs text-muted-foreground">{t("logs.loadingContent")}</p> : null}
    {error ? <div className="px-4 pb-3"><ErrorNotice error={error} /><Button variant="outline" onClick={() => expanded ? void ensureContent().catch(() => {}) : void download()}>{t("common.retry")}</Button></div> : null}
    <div id={contentId} hidden={!expanded} className="border-t">{expanded && !loading && !error ? <>
      {body !== null ? <LogBody body={body.text} truncated={body.truncated} /> : visibleBlocks.length ? <div className="divide-y">{visibleBlocks.map(block => <div key={block.id} className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-muted/30 px-4 py-2 text-xs text-muted-foreground"><span>{t("logs.contentRole")}: <span className="font-medium text-foreground">{block.role}</span></span>{block.source !== block.role ? <span className="break-all">{t("logs.contentSource")}: {block.source}</span> : null}{block.truncated ? <span>{t("logs.truncated")}</span> : null}</div>
        <LogBody body={block.text} truncated={block.truncated} />
      </div>)}</div> : <div className="px-4 py-5 text-sm text-muted-foreground">{t(content.available ? "logs.contentUnavailable" : "logs.contentNotCaptured")}</div>}
      {content.blocks && visibleBlocks.length < content.blocks.length ? <p className="px-4 py-2 text-xs text-muted-foreground">{t("logs.bodyPreviewLimited")}</p> : null}
      {downloadId && !content.httpRequest && content.blocks?.length ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t("logs.legacyBodyOnly")}</p> : null}
      {content.httpRequest?.redactedHeaders.length ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t("logs.httpHeadersRedacted")}</p> : null}
      {transformed ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">{t("logs.transformation")}</p> : null}
    </> : null}</div>
  </section>;
}
