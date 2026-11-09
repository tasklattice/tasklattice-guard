import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { eventSeverity } from "../../shared/security-severity";
const classes = {
  critical: "border-destructive bg-destructive/10 text-destructive",
  high: "border-destructive/40 text-destructive",
  medium: "border-transparent bg-[var(--notice-warning)] text-[var(--warning)]",
  low: "border-border text-foreground",
  informational: "border-primary/30 bg-primary/5 text-primary",
  unclassified: "border-border text-muted-foreground",
};
export function SecuritySeverityBadge({ severity }: { severity: unknown }) {
  const { t } = useTranslation();
  const level = eventSeverity(severity);
  return <Badge variant="outline" className={classes[level]}>{t(`routerDetail.severity.${level}`)}</Badge>;
}
