import { useEffect, useRef, type ReactNode } from "react";
import { Check } from "lucide-react";

import {
  Stepper,
  StepperContent,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperNav,
  StepperPanel,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/reui/stepper";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export type CreationStep = {
  label: string;
  description: string;
};

export function CreationFlow({
  children,
  currentStep,
  onStepChange,
  progressLabel,
  steps,
  orientation = "horizontal",
  freelyNavigable = false,
  contained = false,
}: {
  children: ReactNode;
  currentStep: number;
  onStepChange: (step: number) => void;
  progressLabel: string;
  steps: readonly CreationStep[];
  orientation?: "horizontal" | "sidebar";
  /** Optional protection steps can be visited without implying validation. */
  freelyNavigable?: boolean;
  contained?: boolean;
}) {
  const sidebar = orientation === "sidebar";
  const vertical = sidebar && !useIsMobile();
  const activeValue = currentStep + 1;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (vertical || !freelyNavigable) return;
    const keepActiveStepVisible = () => {
      root.current?.querySelector<HTMLElement>('[aria-current="step"]')?.scrollIntoView?.({ block: "nearest", inline: "center" });
    };
    keepActiveStepVisible();
    // The active step also needs repositioning when a narrow viewport changes size.
    if (!root.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(keepActiveStepVisible);
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [currentStep, vertical, freelyNavigable]);

  function changeStep(value: number) {
    const next = value - 1;
    if (next >= 0 && next < steps.length && (freelyNavigable || next <= currentStep)) onStepChange(next);
  }

  return (
    <div ref={root} className={cn("min-w-0", contained && "h-full min-h-0")}>
    <Stepper
      value={activeValue}
      onValueChange={changeStep}
      orientation={vertical ? "vertical" : "horizontal"}
      indicators={{ completed: <Check className="size-3.5" /> }}
      className={cn(
        contained ? "h-full min-h-0" : "min-h-full",
        vertical ? freelyNavigable ? "grid grid-cols-[18rem_minmax(0,1fr)]" : "grid grid-cols-[13.5rem_minmax(0,1fr)]" : "flex flex-col",
      )}
    >
      <StepperNav
        aria-label={progressLabel}
        className={cn(
          vertical
            ? "w-full border-r bg-muted/15 px-4 py-3"
            : "w-full shrink-0 items-start gap-0 overflow-x-auto border-b bg-muted/20 px-3 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          vertical && (contained ? "h-full overflow-y-auto" : "sticky top-0 min-h-full self-start"),
        )}
      >
        {steps.map((step, index) => (
          <StepperItem
            key={step.label}
            step={index + 1}
            disabled={!freelyNavigable && index > currentStep}
            autoCompletePrevious={!freelyNavigable}
            className={cn(
              "relative justify-start",
              vertical
                ? freelyNavigable ? "min-h-11 w-full items-start not-last:flex-none" : "min-h-[3.75rem] w-full items-start not-last:flex-none last:min-h-11"
                : "min-w-28 items-center",
            )}
          >
            <StepperTrigger
              aria-current={index === currentStep ? "step" : undefined}
              className={cn(
                "relative z-10 min-h-11 text-left transition-colors",
                vertical
                  ? "w-full items-start gap-3 rounded-md px-1.5 py-1.5 hover:text-foreground data-[state=active]:text-primary"
                  : "w-full flex-col gap-1.5 rounded-lg px-2 py-1 text-center hover:bg-background/70",
              )}
            >
              <StepperIndicator
                className={cn(
                  "border-2 border-border bg-background font-mono text-[10px] text-muted-foreground",
                  vertical ? "size-5" : "size-7",
                  "data-[state=active]:border-primary data-[state=active]:bg-background data-[state=active]:text-primary",
                  "data-[state=completed]:border-primary data-[state=completed]:bg-primary data-[state=completed]:text-primary-foreground",
                )}
              >
                {index + 1}
              </StepperIndicator>
              <span className={cn("min-w-0", !vertical && "max-w-28")}>
                <StepperTitle className={cn(freelyNavigable ? "text-xs" : "text-sm", "data-[state=active]:text-primary data-[state=inactive]:text-muted-foreground")}>
                  {step.label}
                </StepperTitle>
                {vertical ? (
                  <StepperDescription className="mt-0.5 text-[11px] leading-4 data-[state=inactive]:text-muted-foreground/65">
                    {step.description}
                  </StepperDescription>
                ) : null}
              </span>
            </StepperTrigger>
            {index < steps.length - 1 ? (
              <StepperSeparator
                className={cn(
                  "group-data-[state=completed]/step:bg-primary",
                  vertical
                    ? "absolute top-7 -bottom-4 left-4 h-auto w-px -translate-x-1/2"
                    : "absolute top-[1.375rem] left-[calc(50%+1rem)] h-px w-[calc(100%-2rem)] -translate-y-1/2",
                )}
              />
            ) : null}
          </StepperItem>
        ))}
      </StepperNav>

      <StepperPanel key={activeValue} className={cn("min-w-0 bg-background", contained && "min-h-0 flex-1 overflow-y-auto overscroll-contain")}>
        <StepperContent value={activeValue} className={cn("min-w-0", sidebar ? "p-4 sm:p-6" : "pt-6")}>
          {children}
        </StepperContent>
      </StepperPanel>
    </Stepper>
    </div>
  );
}

export function ReviewList({
  items,
}: {
  items: readonly { label: string; value: ReactNode; mono?: boolean }[];
}) {
  return (
    <dl className="divide-y rounded-lg border bg-card px-4 text-sm">
      {items.map((item) => (
        <div key={item.label} className="grid grid-cols-[11rem_minmax(0,1fr)] gap-5 py-3">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className={cn("min-w-0 break-words font-medium", item.mono && "font-mono text-xs")}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
