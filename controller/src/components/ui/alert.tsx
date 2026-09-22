import * as React from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-1 rounded-lg border px-4 py-3.5 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive: "border-destructive/20 bg-destructive/5 text-destructive",
        warning: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
        info: "border-primary/20 bg-primary/5 text-foreground [&>svg]:text-primary",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Alert({
  className,
  variant,
  dismissible = false,
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants> & { dismissible?: boolean }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = React.useState(false);
  if (dismissible && dismissed) return null;
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), dismissible && "pr-14", className)}
      {...props}
    >
      {children}
      {dismissible ? <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute right-2 top-2 text-current"
        aria-label={t("common.close")}
        onClick={() => setDismissed(true)}
      ><X aria-hidden="true" /></Button> : null}
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 font-medium leading-none", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("col-start-2 text-sm leading-5 text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle };
