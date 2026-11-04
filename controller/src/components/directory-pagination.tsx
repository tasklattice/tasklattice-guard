import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEventCursor } from "./event-pagination";
import { Button } from "./ui/button";

export function useDirectoryPage(scope: string) {
  const [search, setSearch] = useState("");
  const [q, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const page = useEventCursor(`${scope}:${q}`);
  return {
    search,
    setSearch,
    page,
    query: { q, cursor: page.cursor, limit: 25 },
  };
}
export function DirectoryPagination({
  control,
  nextCursor,
  count,
  busy,
}: {
  control: ReturnType<typeof useDirectoryPage>;
  nextCursor?: string | null;
  count: number;
  busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("projects.directoryPages")}
      className="flex items-center gap-3 border-t px-4 py-3"
    >
      <span className="mr-auto text-xs text-muted-foreground">
        {t("projects.directoryPageSummary", { page: control.page.page, count })}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || control.page.page === 1}
        onClick={control.page.previous}
      >
        {t("common.previous")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !nextCursor}
        onClick={() => {
          if (nextCursor) control.page.next(nextCursor);
        }}
      >
        {t("common.next")}
      </Button>
    </nav>
  );
}
