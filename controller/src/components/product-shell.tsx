import { AlertCircle, Inbox, Info } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  aside,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="text-sm font-medium text-primary">{eyebrow}</p> : null}
        <h1 className={cn("font-display text-3xl font-semibold tracking-[-0.015em] text-foreground sm:text-[2rem]", eyebrow && "mt-1.5")}>
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {action ?? aside}
    </header>
  );
}

export function StateBadge({ state, label }: { state: string; label?: string }) {
  const { t, i18n } = useTranslation();
  const normalized = state.toLowerCase();
  const positive = ["active", "passed", "ready", "healthy", "allow", "pass", "safe", "enabled", "configured", "protected", "local", "success"].includes(normalized);
  const negative = ["failed", "block", "blocked", "reject", "unsafe", "error", "degraded", "disabled", "saturated", "offline"].includes(normalized);
  const warning = ["transform", "redirect", "uncertain", "waiting", "unconfigured", "unavailable", "not evaluated", "stale", "needs_validation", "intervene", "paused", "syncing", "busy"].includes(normalized);

  return (
    <Badge
      variant={negative ? "destructive" : "outline"}
      className={cn(
        "h-5 rounded-sm px-2 text-[11px] font-medium capitalize",
        positive && "border-emerald-200 bg-emerald-50 text-emerald-700",
        warning && "border-amber-200 bg-amber-50 text-amber-700",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-muted-foreground/50",
          positive && "bg-emerald-500",
          negative && "bg-destructive",
          warning && "bg-amber-500",
        )}
      />
      {label ?? (i18n.exists(`states.${normalized}`) ? t(`states.${normalized}`) : state.replaceAll("_", " "))}
    </Badge>
  );
}

export function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <Card size="sm" className="gap-0 border-0 py-3 shadow-none ring-1 ring-border">
      <div className="px-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className="mt-1.5 text-xl font-semibold tracking-[-0.025em] text-foreground tabular-nums">{value}</div>
        {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
      </div>
    </Card>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <Card className="flex min-h-64 items-center justify-center border border-dashed py-10 text-center shadow-none ring-0">
      <div className="flex max-w-md flex-col items-center px-6">
        <span className="mb-4 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Inbox className="size-5" />
        </span>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{description}</p>
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </Card>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useTranslation();
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{t("common.requestFailed")}</AlertTitle>
      <AlertDescription className="text-destructive/80">
        {error instanceof Error ? error.message : t("common.unknownError")}
      </AlertDescription>
    </Alert>
  );
}

export function InfoNotice({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <Alert className="border-primary/20 bg-primary/[0.04] text-foreground">
      <Info className="text-primary" />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription className="leading-5 text-muted-foreground">{children}</AlertDescription>
    </Alert>
  );
}
