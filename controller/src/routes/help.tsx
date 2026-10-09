import { isValidElement, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Link, useLinkProps, useParams, useRouterState } from "@tanstack/react-router";
import { ArrowRight, ChevronRight, Search, X } from "lucide-react";
import type { MDXComponents } from "mdx/types";
import { useTranslation } from "react-i18next";
import { helpStructuralComponents } from "@/components/help/document-blocks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SyntaxCode } from "@/components/syntax-code";
import { cn } from "@/lib/utils";
import { getHelpContent, searchHelpContent, type HelpContent, type HelpDocument } from "@/features/help-content";
import { decodeDocumentAnchor, documentHref } from "@/features/help-navigation";

function DocumentNavigationLink({ href = "", ...props }: ComponentProps<"a">) {
  const pathname = useRouterState({ select: state => state.location.pathname });
  const [path, hash = ""] = href.split("#");
  const linkProps = useLinkProps({ ...props, to: path || pathname, hash: decodeDocumentAnchor(hash), resetScroll: false, hashScrollIntoView: false });
  // Scroll position, not the router's path matching, owns the section highlight.
  return <a {...linkProps} aria-current={props["aria-current"]}>{props.children}</a>;
}

function DocumentLink({ href = "", children, ...props }: ComponentProps<"a">) {
  const className = "inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-primary underline underline-offset-4 hover:bg-primary/5";
  if (href.startsWith("#") || href.startsWith("/document/")) return <DocumentNavigationLink {...props} href={href} className={className}>{children}<ArrowRight className="size-3.5 shrink-0" /></DocumentNavigationLink>;
  // Server documents must make an HTTP request rather than enter the SPA router.
  return href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/api/") && href !== "/metrics"
    ? <Link {...props} to={href} className={className}>{children}<ArrowRight className="size-3.5 shrink-0" /></Link>
    : <a {...props} href={href} className={className}>{children}<ArrowRight className="size-3.5 shrink-0" /></a>;
}
const withControllerOrigin = (text: string) => text.replaceAll("{controllerOrigin}", typeof window === "undefined" ? "$CONTROLLER_URL" : window.location.origin);

/** A fenced block: highlighted by its fence language; unknown languages stay plain. */
function DocumentCodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const { t } = useTranslation();
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const language = code?.props.className?.match(/language-([\w-]+)/)?.[1];
  const content = typeof code?.props.children === "string" ? code.props.children : null;
  const block = "my-4 rounded-lg border bg-muted/30 leading-6";
  if (language && content !== null) {
    return <SyntaxCode content={withControllerOrigin(content).replace(/\n$/, "")} language={language} label={t("common.codeExample", { language })} className={block} />;
  }
  return <pre {...props} className={cn(block, "overflow-x-auto p-4 font-mono text-xs")}>{children}</pre>;
}

const mdxComponents: MDXComponents = {
  ...helpStructuralComponents,
  h2: props => <h2 {...props} className="mt-8 scroll-mt-36 border-t pt-6 text-xl font-semibold first:mt-0 first:border-0 first:pt-0 2xl:scroll-mt-24" />,
  h3: props => <h3 {...props} className="mt-6 scroll-mt-36 text-lg font-semibold 2xl:scroll-mt-24" />,
  p: props => <p {...props} className="mt-3 text-sm leading-7 text-foreground/85" />,
  ul: props => <ul {...props} className="mt-4 list-disc space-y-2 pl-5 text-sm leading-7" />,
  ol: props => <ol {...props} className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-7" />,
  blockquote: props => <blockquote {...props} className="my-5 border-l-2 border-primary bg-primary/5 px-4 py-1 text-muted-foreground" />,
  pre: DocumentCodeBlock,
  code: ({ children, ...props }) => <code {...props} className="font-mono">{typeof children === "string" ? withControllerOrigin(children) : children}</code>,
  a: DocumentLink,
  // Carbon data table colours: an accent header row over white rows, so the
  // header reads apart from the data on the grey page. Code in a cell keeps
  // its line; a wide table scrolls instead of breaking identifiers.
  table: props => <div className="my-4 overflow-x-auto"><table {...props} className="document-table w-full border-collapse text-left text-sm" /></div>,
  th: props => <th {...props} className="border border-[var(--cds-border-subtle-01)] bg-[var(--cds-layer-accent-01)] px-3 py-2 align-bottom font-semibold text-[var(--cds-text-primary)]" />,
  td: props => <td {...props} className="border border-[var(--cds-border-subtle-01)] bg-[var(--cds-layer-01)] px-3 py-2 align-top [&_code]:whitespace-nowrap" />,
};

function DocumentArticle({ document }: { document: HelpDocument }) {
  const { Content } = document;
  return <article id={document.id} className="document-article scroll-mt-36 outline-none 2xl:scroll-mt-24" tabIndex={-1}>
    <header className="border-b pb-6">
      <p className="text-xs font-medium text-primary">{document.categoryTitle}</p>
      <h1 className="mt-2 font-sans text-3xl font-normal tracking-normal">{document.title}</h1>
      <p className="mt-4 text-sm leading-7 text-muted-foreground">{document.summary}</p>
      {document.outcome ? <p className="mt-2 text-xs font-medium text-foreground">{document.outcome}</p> : null}
    </header>
    <div className="mt-8"><Content components={mdxComponents} /></div>
  </article>;
}

function HelpContents({ content, activeDocumentId, onNavigate, idPrefix }: { content: HelpContent; activeDocumentId: string; onNavigate: () => void; idPrefix: string }) {
  const activeCategoryId = content.documents.find(document => document.id === activeDocumentId)?.categoryId ?? content.categories[0]?.id;
  const [expandedCategoryId, setExpandedCategoryId] = useState(activeCategoryId);
  useEffect(() => setExpandedCategoryId(activeCategoryId), [activeCategoryId]);
  return <nav aria-label={content.labels.contents} className="space-y-1 pb-6">
    {content.categories.map(category => {
      const expanded = expandedCategoryId === category.id;
      const current = activeCategoryId === category.id;
      return <div key={category.id} className="border-b border-border/60 pb-1 last:border-0">
        <button type="button" aria-expanded={expanded} aria-controls={`${idPrefix}-category-${category.id}`} className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm font-semibold transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${current ? "text-foreground" : "text-muted-foreground"}`} onClick={() => setExpandedCategoryId(expanded ? "" : category.id)}>
          <span>{category.title}</span>
          <ChevronRight aria-hidden="true" className={`size-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <div id={`${idPrefix}-category-${category.id}`} hidden={!expanded} className="space-y-0.5 pb-2 pl-2">
          {category.articles.map(article => <DocumentNavigationLink key={article.id} href={documentHref(article)} aria-current={activeDocumentId === article.id ? "page" : undefined} className={`flex min-h-11 items-center rounded-md border-l-2 px-3 py-2 text-[13px] leading-5 hover:bg-muted/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${activeDocumentId === article.id ? "border-primary bg-primary/5 font-medium text-primary" : "border-transparent text-muted-foreground"}`} onClick={onNavigate}>{article.title}</DocumentNavigationLink>)}
        </div>
      </div>;
    })}
  </nav>;
}

function OnThisPage({ document, activeAnchor, label, onNavigate }: { document: HelpDocument; activeAnchor: string; label: string; onNavigate: () => void }) {
  const sections = document.sections.length ? document.sections : [{ id: document.id, title: document.title, depth: 2 }];
  return <nav aria-label={`${label}: ${document.title}`} className="border-l pl-4">
    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-foreground">{label}</p>
    <div className="space-y-0.5">{sections.map(section => <DocumentNavigationLink key={section.id} href={documentHref(document, section.id)} aria-current={activeAnchor === section.id ? "location" : undefined} className={`block rounded-sm py-1 text-[13px] leading-5 hover:text-foreground focus-visible:outline-primary ${section.depth >= 3 ? "pl-3" : ""} ${activeAnchor === section.id ? "font-medium text-primary" : "text-muted-foreground"}`} onClick={onNavigate}>{section.title}</DocumentNavigationLink>)}</div>
  </nav>;
}

export function DocumentNotFound() {
  const { i18n } = useTranslation();
  const { labels } = getHelpContent(i18n.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en");
  return <section className="mx-auto max-w-3xl px-8 py-16">
    <h1 className="text-3xl">{labels.notFoundTitle}</h1>
    <p className="mt-4 text-muted-foreground">{labels.notFoundDescription}</p>
    <Link to="/document" className="mt-6 inline-block text-primary underline">{labels.backToDocs}</Link>
  </section>;
}

export function HelpPage() {
  const { i18n } = useTranslation();
  const locale = i18n.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  const content = useMemo(() => getHelpContent(locale), [locale]);
  const { categoryId, articleId } = useParams({ from: "/document/$categoryId/$articleId" });
  const location = useRouterState({ select: state => state.location });
  const activeDocument = content.documents.find(document => document.categoryId === categoryId && document.id === articleId)!;
  const [activeAnchor, setActiveAnchor] = useState(() => decodeDocumentAnchor(location.hash) || activeDocument.id);
  const [query, setQuery] = useState("");
  const mobileContents = useRef<HTMLDetailsElement>(null);
  const inlineContents = useRef<HTMLDetailsElement>(null);
  const desktopDirectory = useRef<HTMLDivElement>(null);
  const pageContents = useRef<HTMLElement>(null);
  const results = useMemo(() => searchHelpContent(content, query), [content, query]);
  const searching = Boolean(query.trim());
  const { labels } = content;
  const activeIndex = content.documents.findIndex(document => document.id === activeDocument.id);

  function closeContents() {
    if (mobileContents.current) mobileContents.current.open = false;
    if (inlineContents.current) inlineContents.current.open = false;
  }
  useEffect(() => {
    const anchor = decodeDocumentAnchor(location.hash);
    const id = activeDocument.sections.some(section => section.id === anchor) ? anchor : activeDocument.id;
    setActiveAnchor(id);
    closeContents();
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (target) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start" });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [location, activeDocument]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let anchor = activeDocument.id;
        for (const section of activeDocument.sections) {
          const element = document.getElementById(section.id);
          if (element && element.getBoundingClientRect().top <= 150) anchor = section.id;
          else break;
        }
        setActiveAnchor(previous => previous === anchor ? previous : anchor);
      });
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); cancelAnimationFrame(frame); };
  }, [activeDocument]);
  useEffect(() => {
    const panel = desktopDirectory.current;
    const link = panel?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!panel || !link) return;
    const panelRect = panel.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    if (linkRect.top < panelRect.top + 12) panel.scrollTop += linkRect.top - panelRect.top - 12;
    else if (linkRect.bottom > panelRect.bottom - 12) panel.scrollTop += linkRect.bottom - panelRect.bottom + 12;
  }, [activeDocument.id]);
  useEffect(() => {
    const panel = pageContents.current;
    const link = panel?.querySelector<HTMLElement>('a[aria-current="location"]');
    if (!panel) return;
    if (!link) { panel.scrollTop = 0; return; }
    const panelRect = panel.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    if (linkRect.top < panelRect.top + 12) panel.scrollTop += linkRect.top - panelRect.top - 12;
    else if (linkRect.bottom > panelRect.bottom - 12) panel.scrollTop += linkRect.bottom - panelRect.bottom + 12;
  }, [activeAnchor, activeDocument.id]);

  function directory(desktop = false) {
    return <>
      <label className="relative block shrink-0">
        <span className="sr-only">{labels.searchLabel}</span>
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" value={query} onChange={event => setQuery(event.target.value)} className="field:h-11 field:bg-card field:pl-9 field:pr-11 field:[&::-webkit-search-cancel-button]:appearance-none" placeholder={labels.searchPlaceholder} />
        {searching ? <Button variant="ghost" size="icon" aria-label={labels.clearSearch} className="absolute top-0 right-0 size-11" onClick={() => setQuery("")}><X className="size-4" /></Button> : null}
      </label>
      <div ref={desktop ? desktopDirectory : undefined} className="mt-3 min-h-0 overflow-y-auto overscroll-contain">
        {searching ? <>
          <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{labels.searchResults} ({results.length})</p>
          {!results.length ? <div className="px-2 py-4"><p className="text-sm font-medium">{labels.noResultsTitle}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{labels.noResultsDescription}</p></div> : null}
          <nav aria-label={labels.searchResults}><ul className="space-y-1">{results.map(result => <li key={result.href}>
            <DocumentNavigationLink href={result.href} className="block min-h-11 rounded-md p-2 hover:bg-muted/60 focus-visible:outline-primary" onClick={closeContents}>
              <span className="block text-[11px] text-muted-foreground">{result.categoryTitle} / {result.documentTitle}</span>
              <span className="mt-1 block text-sm font-medium text-primary">{result.title}</span>
            </DocumentNavigationLink>
          </li>)}</ul></nav>
        </> : <HelpContents content={content} activeDocumentId={activeDocument.id} onNavigate={closeContents} idPrefix={desktop ? "desktop" : "mobile"} />}
      </div>
    </>;
  }

  const previous = content.documents[activeIndex - 1];
  const next = content.documents[activeIndex + 1];
  return <section className="min-w-0 lg:grid lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
    <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] min-h-0 flex-col border-r bg-sidebar px-4 py-6 lg:flex">
      <p className="mb-4 px-3 text-sm font-semibold">{labels.contents}</p>
      {directory(true)}
    </aside>
    <div className="min-w-0 px-4 py-6 sm:px-6 lg:px-10 xl:px-12">
      <div className="mx-auto grid w-full max-w-[76rem] xl:grid-cols-[minmax(0,1fr)_12rem] xl:items-start xl:gap-8">
        <div className="min-w-0">
          <details ref={mobileContents} className="mb-5 rounded-lg border bg-card px-3 lg:hidden">
            <summary className="flex min-h-11 cursor-pointer list-item items-center py-3 text-sm font-medium">{labels.contents}</summary>
            <div className="flex max-h-[60dvh] flex-col pb-3">{directory()}</div>
          </details>
          <details ref={inlineContents} className="sticky top-16 z-10 mb-5 rounded-lg border bg-card px-3 shadow-sm xl:hidden">
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{labels.onThisPage} · {activeDocument.title}</summary>
            <div className="max-h-[50dvh] overflow-y-auto pb-3"><OnThisPage document={activeDocument} activeAnchor={activeAnchor} label={labels.onThisPage} onNavigate={closeContents} /></div>
          </details>
          <DocumentArticle key={activeDocument.id} document={activeDocument} />
          <nav aria-label={labels.articleNavigation} className="mt-16 grid gap-3 border-t pt-6 sm:grid-cols-2">
            {previous ? <DocumentNavigationLink href={documentHref(previous)} className="rounded-lg border p-4 text-sm hover:border-primary/40 hover:bg-primary/5"><span className="block text-xs text-muted-foreground">← {labels.previousArticle}</span><span className="mt-1 block font-medium">{previous.title}</span></DocumentNavigationLink> : <span />}
            {next ? <DocumentNavigationLink href={documentHref(next)} className="rounded-lg border p-4 text-sm hover:border-primary/40 hover:bg-primary/5"><span className="block text-xs text-muted-foreground">{labels.nextArticle} →</span><span className="mt-1 block font-medium">{next.title}</span></DocumentNavigationLink> : null}
          </nav>
        </div>
        <aside ref={pageContents} className="sticky top-24 hidden max-h-[calc(100dvh-7rem)] overflow-y-auto xl:block" aria-label={labels.onThisPage}>
          <OnThisPage document={activeDocument} activeAnchor={activeAnchor} label={labels.onThisPage} onNavigate={closeContents} />
        </aside>
      </div>
    </div>
  </section>;
}
