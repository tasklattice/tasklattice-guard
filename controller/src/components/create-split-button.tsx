import { ComboButton, MenuItem } from "@carbon/react";
import { Upload } from "lucide-react";
import { useEffect, useRef } from "react";
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
  // The menu opens in a portal, so it cannot inherit the button's width. Publish
  // the width before it opens: Carbon aligns the menu by its measured size, and
  // an equal width keeps both edges flush with the button.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const style = document.documentElement.style;
    const observer = new ResizeObserver(() => style.setProperty("--guard-create-button-width", `${element.offsetWidth}px`));
    observer.observe(element);
    return () => { observer.disconnect(); style.removeProperty("--guard-create-button-width"); };
  }, []);
  return <ComboButton ref={root} className="guard-create-button" label={label} size="lg" menuAlignment="bottom-end"
    onClick={(event) => onCreate(event.currentTarget)}
    translateWithId={() => t("common.moreCreateOptions")}>
    <MenuItem label={importLabel} renderIcon={Upload} onClick={() => onImport(root.current?.querySelectorAll("button")[1] ?? null)} />
  </ComboButton>;
}
