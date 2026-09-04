import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Bot, LibraryBig, ServerCog } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const settingsItems = [
  { to: "/settings/status", label: "nav.status", icon: Activity },
  { to: "/settings/providers", label: "nav.providers", icon: ServerCog },
  { to: "/settings/models", label: "nav.models", icon: Bot },
  { to: "/settings/guardrail-catalog", label: "nav.guardrailCatalog", icon: LibraryBig },
] as const;

export function SettingsNavigation() {
  const { t } = useTranslation();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <Tabs value={pathname} className="mt-5 min-w-0 max-w-full gap-0 overflow-x-auto">
      <TabsList aria-label={t("nav.settings")}>
        {settingsItems.map((item) => {
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
