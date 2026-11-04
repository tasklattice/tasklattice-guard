import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Input } from "./ui/input";
import { ErrorNotice } from "./product-shell";
import { DirectoryPagination, useDirectoryPage } from "./directory-pagination";
import type { DirectoryPage } from "../../shared/directory";
import type { PageQuery } from "@/lib/directory-query";

export function DirectoryPicker({
  scope,
  label,
  value,
  onChange,
  load,
}: {
  scope: string;
  label: string;
  value: string;
  onChange: (id: string) => void;
  load: (
    query: PageQuery,
    signal?: AbortSignal,
  ) => Promise<DirectoryPage<{ id: string; name: string }>>;
}) {
  const control = useDirectoryPage(scope);
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["picker", scope, control.query],
    queryFn: ({ signal }) => load(control.query, signal),
  });
  return (
    <section aria-label={label} className="grid gap-3">
      <Input
        aria-label={label}
        placeholder={label}
        value={control.search}
        onChange={(e) => control.setSearch(e.target.value)}
      />
      {query.error && <ErrorNotice error={query.error} />}
      <div role="radiogroup" aria-label={label}>
        {query.data?.items.map((item) => (
          <label
            key={item.id}
            className="flex items-center gap-3 border-b py-3 text-sm"
          >
            <input
              type="radio"
              name={scope}
              checked={value === item.id}
              onChange={() => onChange(item.id)}
            />
            {item.name}
          </label>
        ))}
      </div>
      {query.isPending ? (
        <p role="status">{t("common.loading")}</p>
      ) : (
        !query.data?.items.length && <p>{t("projects.noResults")}</p>
      )}
      <DirectoryPagination
        control={control}
        count={query.data?.items.length ?? 0}
        nextCursor={query.data?.nextCursor}
        busy={query.isFetching}
      />
    </section>
  );
}
