import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DirectoryPage } from "../../shared/directory";
import type { PageQuery } from "@/lib/directory-query";
import { MultiSelectCombobox } from "./ui/multi-select-combobox";
import { Button } from "./ui/button";
import { ErrorNotice } from "./product-shell";

export type DirectorySelection = { id: string; name: string };

export function DirectorySelect({ scope, label, value, onChange, load, disabled, single = false }: {
  scope: string; label: string; value: DirectorySelection[];
  onChange: (value: DirectorySelection[]) => void;
  load: (query: PageQuery, signal?: AbortSignal) => Promise<DirectoryPage<DirectorySelection>>;
  disabled?: boolean; single?: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [q, setQuery] = useState("");
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const query = useInfiniteQuery({
    queryKey: ["directory-select", scope, q], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => load({ q, cursor: pageParam, limit: 25 }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined, retry: false,
  });
  // Keep selected names when the search or result page changes.
  const choices = [...new Map([...value, ...(query.data?.pages.flatMap(page => page.items) ?? [])].map(item => [item.id, item])).values()];
  return <div className="grid gap-2">
    <MultiSelectCombobox ariaLabel={label} placeholder={label} searchPlaceholder={label}
      value={value.map(item => item.id)} options={choices.map(item => ({ value: item.id, label: item.name }))}
      onValueChange={ids => onChange(ids.flatMap(id => choices.filter(item => item.id === id)))}
      onSearchChange={setSearch} selectionMode={single ? "single" : "multiple"} disabled={disabled}
      noOptionsMessage={query.isFetching ? t("accountForm.loading") : t("accountForm.noResults")}
      emptyMessage={query.isFetching ? t("accountForm.loading") : t("accountForm.noResults")} />
    {query.isFetching && <p role="status" className="text-xs text-muted-foreground">{t("accountForm.loading")}</p>}
    {query.error && <div><ErrorNotice error={query.error} /><Button variant="link" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("accountForm.retry")}</Button></div>}
    {query.hasNextPage && <Button variant="link" disabled={query.isFetching || disabled} onClick={() => void query.fetchNextPage()}>{t("accountForm.more")}</Button>}
  </div>;
}
