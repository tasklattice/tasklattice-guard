import { useEffect, useId, useMemo, useRef, useState, type ComponentProps } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ChevronRight, Search, X } from "lucide-react";
import type { MDXComponents } from "mdx/types";
import { useTranslation } from "react-i18next";
import { helpStructuralComponents } from "@/components/help/document-blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getHelpContent, searchHelpContent, type HelpContent, type HelpDocument } from "@/features/help-content";


function DocumentLink({ href = "", children, ...props }: ComponentProps<"a">) {
  const className = "inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-primary underline underline-offset-4 hover:bg-primary/5";
  // Server documents must make an HTTP request rather than enter the SPA router.
  return href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/api/") && href !== "/metrics"
    ? <Link {...props} to={href} className={className}>{children}<ArrowRight className="size-3.5 shrink-0" /></Link>
    : <a {...props} href={href} className={className}>{children}<ArrowRight className="size-3.5 shrink-0" /></a>;
}
const mdxComponents: MDXComponents = {
  ...helpStructuralComponents,
  h2: props => <h2 {...props} className="mt-8 scroll-mt-24 text-xl font-semibold" />,
  h3: props => <h3 {...props} className="mt-8 scroll-mt-24 border-t pt-6 text-lg font-semibold first:mt-0 first:border-0 first:pt-0" />,
  p: props => <p {...props} className="mt-3 max-w-[80ch] text-sm leading-7 text-foreground/85" />,
  ul: props => <ul {...props} className="mt-4 max-w-[80ch] list-disc space-y-2 pl-5 text-sm leading-7" />,
  ol: props => <ol {...props} className="mt-4 max-w-[80ch] list-decimal space-y-3 pl-5 text-sm leading-7" />,
  blockquote: props => <blockquote {...props} className="my-5 border-l-2 border-primary bg-primary/5 px-4 py-1 text-muted-foreground" />,
  pre: props => <pre {...props} className="my-4 overflow-x-auto rounded-lg border bg-muted/30 p-4 text-xs leading-6" />,
  code: ({ children, ...props }) => <code {...props}>{typeof children === "string" ? children.replaceAll("{controllerOrigin}", typeof window === "undefined" ? "$CONTROLLER_URL" : window.location.origin) : children}</code>,
  a: DocumentLink,
  table: props => <div className="my-4 overflow-x-auto"><table {...props} className="w-full border-collapse text-left text-sm" /></div>,
  th: props => <th {...props} className="border bg-muted/30 px-3 py-2" />,
  td: props => <td {...props} className="border px-3 py-2" />,
};

function DocumentSection({ document }: { document: HelpDocument }) {
  const { Content } = document;
  return <section id={document.id} className="scroll-mt-24 outline-none" tabIndex={-1}>
    {document.label ? <p className="text-xs font-medium text-primary">{document.label}</p> : null}
    <h2 className="mt-1 text-2xl font-semibold">{document.title}</h2>
    <p className="mt-3 max-w-[80ch] text-sm leading-7 text-muted-foreground">{document.summary}</p>
    {document.outcome ? <p className="mt-2 text-xs font-medium">{document.outcome}</p> : null}
    <div className="mt-5"><Content components={mdxComponents} /></div>
  </section>;
}
function HelpContents({ content, expanded, onToggle, onNavigate }: { content: HelpContent; expanded: Set<string>; onToggle: (id: string) => void; onNavigate: (id: string) => void }) {
  const contentsId = useId();
  const linkClass = "flex min-h-11 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-primary";
  return <nav aria-label={content.labels.contents} className="space-y-1" onClick={event => { const link = (event.target as HTMLElement).closest("a"); if (link?.hash) { event.preventDefault(); onNavigate(decodeURIComponent(link.hash.slice(1))); } }}>
    {[content.api, ...content.documents].map(document => <div key={document.id}>
      <div className="flex items-center">
        <a className={`${linkClass} min-w-0 flex-1 font-medium text-foreground`} href={`#${document.id}`}>{document.label ?? document.title}</a>
        {document.sections.length > 0 ? <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label={document.label ?? document.title} aria-expanded={expanded.has(document.id)} aria-controls={`${contentsId}-${document.id}`} onClick={() => onToggle(document.id)}>
          <ChevronRight aria-hidden="true" className={`size-4 ${expanded.has(document.id) ? "rotate-90" : ""}`} />
        </Button> : null}
      </div>
      {document.sections.length > 0 ? <div id={`${contentsId}-${document.id}`} hidden={!expanded.has(document.id)} className="ml-2 border-l pl-2">{document.sections.map(section => <a key={section.id} className={linkClass} href={`#${section.id}`}>{section.title}</a>)}</div> : null}
    </div>)}
  </nav>;
}

export function HelpPage() {
  const { i18n } = useTranslation();
  const locale = i18n.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  const content = useMemo(() => getHelpContent(locale), [locale]);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const anchor = typeof window === "undefined" ? "" : window.location.hash.slice(1);
    return new Set([content.api, ...content.documents].filter(document => document.id === anchor || document.sections.some(section => section.id === anchor)).map(document => document.id));
  });
  function toggleContents(id: string) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const [query, setQuery] = useState("");
  const [pendingAnchor, setPendingAnchor] = useState<string>();
  const mobileContents = useRef<HTMLDetailsElement>(null);
  const results = useMemo(() => searchHelpContent(content, query), [content, query]);
  const searching = Boolean(query.trim());
  const { labels, api } = content;
  const ApiContent = api.Content;
  function navigate(id: string) {
    const parent = [content.api, ...content.documents].find(document => document.id === id || document.sections.some(section => section.id === id));
    if (parent) setExpanded(previous => new Set(previous).add(parent.id));
    if (mobileContents.current) mobileContents.current.open = false;
    setPendingAnchor(id);
  }
  useEffect(() => {
    if (!pendingAnchor) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(pendingAnchor);
      if (target) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start" });
        window.history.replaceState(window.history.state, "", `#${pendingAnchor}`);
      }
      setPendingAnchor(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingAnchor]);

  function directory() {
    return <>
      <label className="relative block shrink-0">
        <span className="sr-only">{labels.searchLabel}</span>
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" value={query} onChange={event => setQuery(event.target.value)} className="h-11 bg-card pl-9 pr-11 [&::-webkit-search-cancel-button]:appearance-none" placeholder={labels.searchPlaceholder} />
        {searching ? <Button variant="ghost" size="icon" aria-label={labels.clearSearch} className="absolute top-0 right-0 size-11" onClick={() => setQuery("")}><X className="size-4" /></Button> : null}
      </label>
      <div className="mt-3 min-h-0 overflow-y-auto overscroll-contain">
        {searching ? <>
          <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{labels.searchResults} ({results.length})</p>
          {!results.length ? <div className="px-2 py-4"><p className="text-sm font-medium">{labels.noResultsTitle}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{labels.noResultsDescription}</p></div> : null}
          <nav aria-label={labels.searchResults}><ul className="space-y-1">{results.map(result => <li key={result.id}>
            <a href={`#${result.id}`} className="block min-h-11 rounded-md p-2 hover:bg-muted/60 focus-visible:outline-primary" onClick={event => { event.preventDefault(); navigate(result.id); }}>
              <span className="block text-[11px] text-muted-foreground">{result.documentTitle}</span>
              <span className="mt-1 block text-sm font-medium text-primary">{result.title}</span>
            </a>
          </li>)}</ul></nav>
        </> : <HelpContents content={content} expanded={expanded} onToggle={toggleContents} onNavigate={navigate} />}
      </div>
    </>;
  }

  return <section className="py-4">
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b pb-3">
      <h1 className="font-display text-2xl font-semibold tracking-tight">{labels.title}</h1>
      <nav id={api.id} aria-label={api.title} className="flex scroll-mt-24 flex-wrap gap-x-1 [&>p]:mt-0 [&_a]:text-xs [&_a]:font-medium [&_a]:no-underline"><ApiContent components={mdxComponents} /></nav>
    </header>
    <details ref={mobileContents} className="mt-4 rounded-lg border bg-card px-3 lg:hidden">
      <summary className="flex min-h-11 cursor-pointer list-item items-center py-3 text-sm font-medium">{labels.contents}</summary>
      <div className="flex max-h-[60dvh] flex-col pb-3">{directory()}</div>
    </details>
    <div className="mt-5 grid min-w-0 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
      <aside className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] flex-col border-r pr-4 lg:flex">{directory()}</aside>
      <div className="min-w-0 space-y-12 pb-8">{content.documents.map(document => <DocumentSection key={document.id} document={document} />)}</div>
    </div>
  </section>;
}
