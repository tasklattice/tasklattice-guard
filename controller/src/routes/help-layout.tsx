import { useEffect } from "react";
import { Link, Outlet } from "@tanstack/react-router";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getHelpContent } from "@/features/help-content";
import { useAuth } from "@/lib/auth";
import type { SupportedLanguage } from "@/i18n";

export function HelpLayout() {
  const { t, i18n } = useTranslation();
  const { setLanguage } = useAuth();
  const locale = i18n.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  const { labels } = getHelpContent(locale);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "TaskLattice Guard Document";
    return () => { document.title = previousTitle; };
  }, []);

  return <div className="min-h-dvh bg-background">
    <header className="sticky top-0 z-20 border-b bg-background">
      <div className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 px-4 py-2 sm:px-6 lg:px-8">
        <Link to="/document" className="flex min-h-11 items-center gap-2 rounded-md text-sm font-semibold focus-visible:outline-primary">
          <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
          TaskLattice Guard <span className="font-normal text-muted-foreground">Document</span>
        </Link>
        <div className="flex items-center gap-3">
          <select aria-label={t("common.language")} value={locale} onChange={event => void setLanguage(event.target.value as SupportedLanguage)} className="min-h-11 rounded-md border bg-background px-3 text-sm focus-visible:outline-primary">
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
          <Link to="/dashboard" className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-primary">
            <ArrowLeft aria-hidden="true" className="size-4" />{labels.backToPortal}
          </Link>
        </div>
      </div>
    </header>
    <main className="w-full min-w-0"><Outlet /></main>
  </div>;
}
