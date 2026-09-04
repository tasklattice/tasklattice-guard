import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/product-shell";
import { RunnerCapacitySection, runnerPoolKey } from "@/components/runner-capacity";
import { SettingsNavigation } from "@/components/settings-navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RunnerPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refreshing = useIsFetching({ queryKey: runnerPoolKey }) > 0;

  return (
    <section className="py-6 sm:py-8">
      <PageHeader
        title={t("runners.pageTitle")}
        description={t("runners.description")}
        action={(
          <Button
            type="button"
            variant="outline"
            className="min-h-11 self-start"
            disabled={refreshing}
            onClick={() => void queryClient.invalidateQueries({ queryKey: runnerPoolKey })}
          >
            <RefreshCw className={cn(refreshing && "animate-spin motion-reduce:animate-none")} />
            {t(refreshing ? "runners.refreshing" : "runners.refresh")}
          </Button>
        )}
      />
      <SettingsNavigation />
      <div className="mt-6">
        <RunnerCapacitySection showHeader={false} />
      </div>
    </section>
  );
}
