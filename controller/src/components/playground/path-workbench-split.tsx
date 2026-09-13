import { useRef, useState, type ReactNode } from "react";
import { useRoutingText } from "@/components/traffic-routing/form";

/** One scroll owner per pane; the separator supports pointer and keyboard resizing. */
export function PathWorkbenchSplit({
  request,
  result,
}: {
  request: ReactNode;
  result: ReactNode;
}) {
  const t = useRoutingText();
  const [height, setHeight] = useState(45);
  const drag = useRef({ y: 0, height: 45 });
  const container = useRef<HTMLDivElement>(null);
  const resize = (next: number) => setHeight(Math.min(60, Math.max(30, next)));
  return (
    <div
      ref={container}
      className="flex h-[38rem] min-h-[30rem] flex-col lg:h-[calc(100dvh-25rem)]"
    >
      <div style={{ height: `${height}%` }} className="min-h-0 shrink-0">
        {request}
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label={t("调整请求区高度", "Resize request panel")}
        aria-orientation="horizontal"
        aria-valuemin={30}
        aria-valuemax={60}
        aria-valuenow={height}
        className="group relative z-10 flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center border-y bg-muted/30 outline-none before:absolute before:inset-x-0 before:-inset-y-4 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        onPointerDown={(e) => {
          drag.current = { y: e.clientY, height };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            resize(
              drag.current.height +
                ((e.clientY - drag.current.y) /
                  (container.current?.clientHeight || 1)) *
                  100,
            );
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
        onKeyDown={(e) => {
          if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
            e.preventDefault();
            resize(
              e.key === "Home"
                ? 30
                : e.key === "End"
                  ? 60
                  : height + (e.key === "ArrowDown" ? 5 : -5),
            );
          }
        }}
      >
        <span className="h-0.5 w-10 rounded bg-border group-hover:bg-muted-foreground" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{result}</div>
    </div>
  );
}
