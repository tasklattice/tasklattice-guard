import { cn } from "@/lib/utils";

/** Shared TaskLattice website mark, also used by Veritas. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={cn("brand-lattice-mark size-8 shrink-0", className)} viewBox="0 0 64 64">
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M8 10h48L32 56 8 10Z" />
        <path d="M32 10v46M16 30h32M8 10l40 20M56 10 16 30M16 30l16 26M48 30 32 56" />
      </g>
      <g fill="var(--brand-signal)" stroke="var(--brand-surface)" strokeWidth="1.5">
        <circle cx="8" cy="10" r="3.5" />
        <circle cx="32" cy="10" r="3.5" />
        <circle cx="56" cy="10" r="3.5" />
        <circle cx="16" cy="30" r="3.5" />
        <circle cx="32" cy="30" r="3.5" />
        <circle cx="48" cy="30" r="3.5" />
        <circle cx="32" cy="56" r="3.5" />
      </g>
    </svg>
  );
}

export function BrandLogo({ className, wordmarkClassName, onPrimary = false }: {
  className?: string;
  wordmarkClassName?: string;
  onPrimary?: boolean;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5 text-foreground", onPrimary && "brand-on-primary", className)}>
      <BrandMark />
      <span className={cn("min-w-0 whitespace-nowrap text-sm font-semibold tracking-[-0.02em]", wordmarkClassName)}>
        TaskLattice <span className={cn("font-medium", onPrimary ? "text-current/70" : "text-muted-foreground")}>Guard</span>
      </span>
    </span>
  );
}
