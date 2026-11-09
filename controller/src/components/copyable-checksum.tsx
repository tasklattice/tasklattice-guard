import type { KeyboardEvent } from "react";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const DEFAULT_PREFIX_LENGTH = 12;
const DEFAULT_SUFFIX_LENGTH = 8;

export function abbreviateChecksum(
  value: string,
  prefixLength = DEFAULT_PREFIX_LENGTH,
  suffixLength = DEFAULT_SUFFIX_LENGTH,
) {
  if (value.length <= prefixLength + suffixLength + 1) return value;
  return `${value.slice(0, prefixLength)}…${value.slice(-suffixLength)}`;
}

export function CopyableChecksum({ value }: { value?: string | null }) {
  const { t } = useTranslation();
  const checksum = value || "—";
  const canCopy = Boolean(value);

  const copyChecksum = async () => {
    if (!value) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard is unavailable.");
      await navigator.clipboard.writeText(value);
      toast.success(t("common.checksumCopied"));
    } catch {
      toast.error(t("common.checksumCopyFailed"));
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!canCopy || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    void copyChecksum();
  };

  if (!canCopy) return <code className="font-mono text-xs">{checksum}</code>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="group flex min-h-11 max-w-full items-center gap-2 rounded-md px-2 text-left font-mono text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={t("common.copyChecksumLabel", { checksum })}
          onDoubleClick={() => void copyChecksum()}
          onKeyDown={handleKeyDown}
        >
          <code className="min-w-0 truncate">{abbreviateChecksum(checksum)}</code>
          <Copy aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-96 items-start text-left">
        <code className="block break-all font-mono text-[11px] leading-4">{checksum}</code>
        <span className="mt-1 block text-[11px] text-primary-foreground/75">{t("common.copyChecksumHint")}</span>
      </TooltipContent>
    </Tooltip>
  );
}
