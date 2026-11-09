import { useId, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { OutputDelivery, SafetyLevel } from "@/lib/api";

export function RuntimePostureFields({
  safetyLevel,
  outputDelivery,
  onSafetyLevelChange,
  onOutputDeliveryChange,
}: {
  safetyLevel: SafetyLevel;
  outputDelivery: OutputDelivery;
  onSafetyLevelChange: (value: SafetyLevel) => void;
  onOutputDeliveryChange: (value: OutputDelivery) => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const safetyId = `${fieldId}-safety-level`;
  const safetyDescriptionId = `${safetyId}-description`;
  const deliveryId = `${fieldId}-output-delivery`;
  const deliveryDescriptionId = `${deliveryId}-description`;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
      <RuntimeField
        controlId={safetyId}
        descriptionId={safetyDescriptionId}
        label={t("guardrailWizard.safetyLevel")}
        helpLabel={t("guardrailWizard.safetyLevelHelpLabel")}
        help={t("guardrailWizard.safetyLevelHelp")}
        helpAlign="start"
        description={t(`guardrailWizard.safetyLevelDescriptions.${safetyLevel}`)}
      >
        <Select value={safetyLevel} onValueChange={(value) => onSafetyLevelChange(value as SafetyLevel)}>
          <SelectTrigger id={safetyId} aria-describedby={safetyDescriptionId} className="field:min-h-11 field:bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="balanced">{t("guardrailWizard.safetyLevelOptions.balanced")}</SelectItem>
            <SelectItem value="strict">{t("guardrailWizard.safetyLevelOptions.strict")}</SelectItem>
          </SelectContent>
        </Select>
      </RuntimeField>

      <RuntimeField
        controlId={deliveryId}
        descriptionId={deliveryDescriptionId}
        label={t("guardrailWizard.outputDelivery")}
        helpLabel={t("guardrailWizard.outputDeliveryHelpLabel")}
        help={t("guardrailWizard.outputDeliveryHelp")}
        helpAlign="end"
        description={t(`guardrailWizard.outputDeliveryDescriptions.${outputDelivery}`)}
      >
        <Select value={outputDelivery} onValueChange={(value) => onOutputDeliveryChange(value as OutputDelivery)}>
          <SelectTrigger id={deliveryId} aria-describedby={deliveryDescriptionId} className="field:min-h-11 field:bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="interruptible">{t("guardrailWizard.outputDeliveryOptions.interruptible")}</SelectItem>
            <SelectItem value="window_buffered">{t("guardrailWizard.outputDeliveryOptions.window_buffered")}</SelectItem>
            <SelectItem value="full_buffered">{t("guardrailWizard.outputDeliveryOptions.full_buffered")}</SelectItem>
          </SelectContent>
        </Select>
      </RuntimeField>
    </div>
  );
}

function RuntimeField({
  controlId,
  descriptionId,
  label,
  helpLabel,
  help,
  helpAlign,
  description,
  children,
}: {
  controlId: string;
  descriptionId: string;
  label: string;
  helpLabel: string;
  help: string;
  helpAlign: "start" | "end";
  description: string;
  children: ReactNode;
}) {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="grid min-w-0 content-start gap-2">
      <div className="flex min-h-7 items-center gap-1">
        <Label htmlFor={controlId}>{label}</Label>
        <Tooltip open={helpOpen} onOpenChange={setHelpOpen}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="relative text-muted-foreground shadow-none before:absolute before:-inset-2 hover:text-foreground"
              aria-label={helpLabel}
              onClick={() => setHelpOpen((current) => !current)}
            >
              <CircleHelp className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" align={helpAlign} sideOffset={6} className="items-start text-left leading-5">
            {help}
          </TooltipContent>
        </Tooltip>
      </div>
      {children}
      <p id={descriptionId} aria-live="polite" className="min-h-10 text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
