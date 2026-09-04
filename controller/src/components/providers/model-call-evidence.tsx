import { useState } from "react";
import { ArrowUpRight, Copy, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { StateBadge } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ModelDefinition } from "@/lib/controller-api";

export function ModelCallEvidence({ model, checking = false }: { model: ModelDefinition; checking?: boolean }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const status = model.connectionStatus ?? "pending";
  const checked = model.connectionCheckedAt;
  const failed = !checking && status === "failed";
  const message = model.connectionMessage || t("modelSettings.callErrorUnavailable");
  // Preview only: keep the full server response in the inspector, outside table layout.
  const summary = message.length > 240 ? `${message.slice(0, 240)}…` : message;
  const badge = <StateBadge state={checking ? "running" : status === "validated" ? "ready" : status === "failed" ? "failed" : "not evaluated"}
    label={t(checking ? "modelSettings.testingCall" : status === "validated" ? "modelSettings.callPassed" : status === "failed" ? "modelSettings.callFailed" : "modelSettings.notChecked")} />;
  const timestamp = !checking && checked ? <time className="mt-1.5 block whitespace-normal text-[11px] text-muted-foreground" dateTime={checked}>{t("modelSettings.lastChecked", { time: new Date(checked).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }), latency: model.connectionLatencyMs ?? "—" })}</time> : null;
  return <div className="min-w-36 max-w-sm whitespace-normal" aria-live="polite">
    {failed ? <Sheet open={open} onOpenChange={setOpen}>
      <TooltipProvider delayDuration={250}>
        <Tooltip open={!open && previewOpen} onOpenChange={setPreviewOpen}>
          <TooltipTrigger asChild><SheetTrigger asChild>
            <button type="button" className="inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-md text-destructive hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" aria-label={`${t("modelSettings.viewCallError")} · ${model.name}`}>
              {badge}<ArrowUpRight className="size-3.5" aria-hidden="true" />
            </button>
          </SheetTrigger></TooltipTrigger>
          <TooltipContent side="top" align="start" sideOffset={8} collisionPadding={16} className="block max-w-[min(24rem,calc(100vw-2rem))] whitespace-normal p-3 leading-5">
            <p className="font-semibold">{t("modelSettings.callFailed")}</p>
            <p className="mt-1 [overflow-wrap:anywhere]">{summary}</p>
            <p className="mt-2 opacity-80">{t("modelSettings.callErrorHint")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <SheetContent showCloseButton={false} className="!w-full gap-0 sm:!max-w-xl">
        <SheetHeader className="relative shrink-0 border-b p-6 pr-16">
          <SheetTitle>{t("modelSettings.callErrorTitle")}</SheetTitle>
          <SheetDescription className="mt-2 [overflow-wrap:anywhere]">{model.name}</SheetDescription>
          <SheetClose asChild><Button variant="ghost" size="icon" className="absolute right-3 top-3 size-11" aria-label={t("common.close")}><X /></Button></SheetClose>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
          <div>{badge}{timestamp}<code className="mt-3 block text-xs text-muted-foreground [overflow-wrap:anywhere]">{model.model}</code></div>
          <section aria-label={t("modelSettings.callErrorResponse")}>
            <h3 className="mb-2 text-sm font-semibold">{t("modelSettings.callErrorResponse")}</h3>
            <pre className="rounded-md border border-destructive/20 bg-destructive/5 p-4 font-mono text-xs leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</pre>
          </section>
        </div>
        <SheetFooter className="shrink-0 border-t p-4">
          <Button type="button" variant="outline" className="h-11" onClick={async () => {
            try { await navigator.clipboard.writeText(message); toast.success(t("modelSettings.callErrorCopied")); }
            catch { toast.error(t("modelSettings.callErrorCopyFailed")); }
          }}><Copy />{t("modelSettings.copyCallError")}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet> : badge}
    {timestamp}
  </div>;
}
