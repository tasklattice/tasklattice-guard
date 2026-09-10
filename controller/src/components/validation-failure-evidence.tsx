import { ArrowUpRight, Copy, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { StateBadge } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function ValidationFailureEvidence({
  examples,
  label,
  title,
  subject,
  message,
  hint,
  detailLabel,
  copyLabel,
  copiedMessage,
  copyFailedMessage,
  closeLabel,
}: {
  examples?: Array<{ id: string; fields: Array<{ label: string; value: string }> }>;
  label: string;
  title: string;
  subject: string;
  message: string;
  hint: string;
  detailLabel: string;
  copyLabel: string;
  copiedMessage: string;
  copyFailedMessage: string;
  closeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const summary = message.length > 240 ? `${message.slice(0, 240)}…` : message;
  const badge = <StateBadge state="failed" label={label} />;

  return <Sheet open={open} onOpenChange={setOpen}>
    <TooltipProvider delayDuration={250}>
      <Tooltip open={!open && previewOpen} onOpenChange={setPreviewOpen}>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <button type="button" className="inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-md text-destructive hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" aria-label={`${label} · ${subject}`}>
              {badge}<ArrowUpRight className="size-3.5" aria-hidden="true" />
            </button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" sideOffset={8} collisionPadding={16} className="block max-w-[min(30rem,calc(100vw-2rem))] whitespace-normal p-3 leading-5">
          <p className="font-semibold">{label}</p>
          <p className="mt-1 [overflow-wrap:anywhere]">{summary}</p>
          <p className="mt-2 opacity-80">{hint}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <SheetContent showCloseButton={false} className="!w-full gap-0 sm:!max-w-xl">
      <SheetHeader className="relative shrink-0 border-b p-6 pr-16">
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription className="mt-2 [overflow-wrap:anywhere]">{subject}</SheetDescription>
        <SheetClose asChild><Button variant="ghost" size="icon" className="absolute right-3 top-3 size-11" aria-label={closeLabel}><X /></Button></SheetClose>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        {badge}
        {examples?.map((example) => <section key={example.id} className="space-y-3 rounded-lg border p-4">
          <h3 className="text-sm font-semibold [overflow-wrap:anywhere]">{example.id}</h3>
          <dl className="space-y-3">{example.fields.map((field) => <div key={field.label}>
            <dt className="mb-1 text-xs font-medium text-muted-foreground">{field.label}</dt>
            <dd className="rounded-md bg-muted/40 p-3 font-mono text-xs leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">{field.value}</dd>
          </div>)}</dl>
        </section>)}
        <section aria-label={detailLabel}>
          <h3 className="mb-2 text-sm font-semibold">{detailLabel}</h3>
          <pre className="rounded-md border border-destructive/20 bg-destructive/5 p-4 font-mono text-xs leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</pre>
        </section>
      </div>
      <SheetFooter className="shrink-0 border-t p-4">
        <Button type="button" variant="outline" className="h-11" onClick={async () => {
          try { await navigator.clipboard.writeText([message, ...(examples ?? []).map((example) => `${example.id}\n${example.fields.map((field) => `${field.label}: ${field.value}`).join("\n")}`)].join("\n\n")); toast.success(copiedMessage); }
          catch { toast.error(copyFailedMessage); }
        }}><Copy />{copyLabel}</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>;
}
