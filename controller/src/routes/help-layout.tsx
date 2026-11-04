import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEffect } from "react";
import { Link, Outlet } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getHelpContent } from "@/features/help-content";
import { useAuth } from "@/lib/auth";
import type { SupportedLanguage } from "@/i18n";
import { BrandLogo } from "@/components/brand-logo";

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
          <BrandLogo /> <span className="font-normal text-muted-foreground">{t("uiCopy.document")}</span>
        </Link>
        <div className="flex items-center gap-3">
          <Select value={locale} onValueChange={value => void setLanguage(value as SupportedLanguage)}>
            <SelectTrigger aria-label={t("common.language")} className="w-40 field:h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zh-CN">{t("common.chinese")}</SelectItem>
              <SelectItem value="en">{t("common.english")}</SelectItem>
            </SelectContent>
          </Select>
          <Link to="/" className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-primary">
            <ArrowLeft aria-hidden="true" className="size-4" />{labels.backToPortal}
          </Link>
        </div>
      </div>
    </header>
    <main className="w-full min-w-0"><Outlet /></main>
  </div>;
}
