import { useTranslation } from "react-i18next";
import type { EndpointSetupStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export function EndpointSetupBadge({ status }: { status: EndpointSetupStatus }) {
  const { t } = useTranslation();
  const verified = status === "verified";
  const disabled = status === "disabled";
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-6 rounded-md px-2 text-[11px] font-medium",
        verified && "border-emerald-200 bg-emerald-50 text-emerald-700",
        !verified && !disabled && "border-amber-200 bg-amber-50 text-amber-700",
        disabled && "bg-muted text-muted-foreground",
      )}
    >
      <span className={cn("size-1.5 rounded-full bg-muted-foreground/50", verified && "bg-emerald-500", !verified && !disabled && "bg-amber-500")} />
      {t(`endpoints.setupStatuses.${status}`)}
    </Badge>
  );
}
