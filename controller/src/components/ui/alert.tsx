import { useState, type ComponentProps, type ReactNode } from "react";
import { ActionableNotification } from "@carbon/react";
import { useTranslation } from "react-i18next";
import { textContent, findSlots } from "@/components/carbon/composition";
import { cn } from "@/lib/utils";
export function Alert({
  variant = "default",
  dismissible = false,
  children,
  className,
  role,
  ...props
}: ComponentProps<"div"> & {
  variant?: "default" | "destructive" | "warning" | "info";
  dismissible?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const { t } = useTranslation();
  const title = findSlots(children, AlertTitle)[0];
  const description = findSlots(children, AlertDescription)[0];
  if (dismissed) return null;
  return (
    <ActionableNotification
      inline
      {...props}
      role={
        role === "status"
          ? "status"
          : role === "log"
            ? "log"
            : role === "alert" ||
                variant === "destructive" ||
                variant === "warning"
              ? "alert"
              : "status"
      }
      data-slot="alert"
      className={cn("guard-notification", className)}
      kind={
        variant === "destructive"
          ? "error"
          : variant === "warning"
            ? "warning"
            : "info"
      }
      lowContrast
      title={textContent(title?.props.children as ReactNode)}
      hideCloseButton={!dismissible}
      aria-label={t("common.close")}
      onClose={() => {
        setDismissed(true);
        return true;
      }}
    >
      {
        (description?.props.children ??
          (!title ? children : undefined)) as ReactNode
      }
    </ActionableNotification>
  );
}
export function AlertTitle(_props: ComponentProps<"div">) {
  return null;
}
export function AlertDescription(_props: ComponentProps<"div">) {
  return null;
}
