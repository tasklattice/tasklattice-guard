import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, GitBranch, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { isPlatformAdministrator } from "../../shared/rbac";

const settingsItems = [
  { to: "/settings/health", label: "nav.health", icon: Activity },
  { to: "/settings/runner", label: "nav.runner", icon: Server },
  { to: "/settings/version", label: "nav.version", icon: GitBranch },
] as const;

export function SettingsNavigation() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (isPlatformAdministrator(user?.role)) return null;
  return <Tabs value={pathname} className="mt-5">
    <TabsList aria-label={t("nav.settings")}>
      {settingsItems.map(item => <TabsTrigger key={item.to} value={item.to} asChild>
        <Link to={item.to}><item.icon className="size-4" />{t(item.label)}</Link>
      </TabsTrigger>)}
    </TabsList>
  </Tabs>;
}
