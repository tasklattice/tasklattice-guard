import { ComboButton, MenuItem } from "@carbon/react";
import { Upload } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * The create entry shared by Guardrails and Policies: the button creates
 * directly, and importing waits behind the arrow, closed by default. Each
 * callback receives the control that opened it, to return focus there.
 */
export function CreateSplitButton({ label, importLabel, onCreate, onImport }: {
  label: string;
  importLabel: string;
  onCreate: (opener: HTMLElement) => void;
  onImport: (opener: HTMLElement | null) => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  return <ComboButton ref={root} label={label} size="lg" menuAlignment="bottom-end"
    onClick={(event) => onCreate(event.currentTarget)}
    translateWithId={() => t("common.moreCreateOptions")}>
    <MenuItem label={importLabel} renderIcon={Upload} onClick={() => onImport(root.current?.querySelectorAll("button")[1] ?? null)} />
  </ComboButton>;
}
