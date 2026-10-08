import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, GitBranch, Bot, LibraryBig, Server, ServerCog } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDeploymentCapabilities } from "@/lib/deployment";

const settingsItems = [
  { to: "/settings/health", label: "nav.health", icon: Activity },
  { to: "/settings/runner", label: "nav.runner", icon: Server },
  { to: "/settings/providers", label: "nav.providers", icon: ServerCog },
  { to: "/settings/models", label: "nav.models", icon: Bot },
  // The catalog of presets exists only where Guardrails are authored.
  { to: "/settings/guardrail-catalog", label: "nav.guardrailCatalog", icon: LibraryBig, authoring: true },
  { to: "/settings/version", label: "nav.version", icon: GitBranch },
] as const;

export function SettingsNavigation() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { authoringEnabled } = useDeploymentCapabilities();

  return (
    <Tabs value={pathname} className="mt-5 min-w-0 max-w-full gap-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <TabsList aria-label={t("nav.settings")}>
        {settingsItems.filter((item) => authoringEnabled || !("authoring" in item)).map((item) => {
          return (
            <TabsTrigger
              key={item.to}
              value={item.to}
              asChild
            >
              <Link to={item.to}>
                <item.icon className="size-4" />
                {t(item.label)}
              </Link>
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
