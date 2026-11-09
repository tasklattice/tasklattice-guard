import { Dropdown, Pagination, Search } from '@carbon/react';
import { useId, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';
import { EmptyState, ErrorNotice } from './product-shell';
import { Skeleton } from './ui/skeleton';
import './resource-list.scss';

export type ResourceFilter<T> = {
  label: string;
  options: { value: string; label: string }[];
  matches: (item: T, value: string) => boolean;
};

/** Shared desktop collection surface. Domain actions remain owned by each page. */
export function ResourceList<T>({ items, label, searchPlaceholder, searchText, filter, action, loading, refreshing, error, onRefresh, emptyTitle, emptyDescription, summary, children }: {
  items: T[]; label: string; searchPlaceholder: string; searchText: (item: T) => string;
  filter?: ResourceFilter<T>; action?: ReactNode; loading?: boolean; refreshing?: boolean; error?: unknown;
  onRefresh?: () => void; emptyTitle: string; emptyDescription: string; summary?: ReactNode;
  children: (items: T[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const filtered = items.filter(item => searchText(item).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && (!selected || !filter || filter.matches(item, selected)));
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  const active = Boolean(search || selected);
  const clear = () => { setSearch(''); setSelected(''); setPage(1); };
  return <section className="resource-list" aria-label={label}>
    <div className="resource-list-toolbar">
      <Search id={`${id}-search`} size="lg" labelText={searchPlaceholder} placeholder={searchPlaceholder} value={search}
        closeButtonLabelText={t('resourceList.clearSearch')} onChange={event => { setSearch(event.target.value); setPage(1); }} onClear={() => { setSearch(''); setPage(1); }} />
      {filter && <div className="resource-list-filter"><Dropdown id={`${id}-filter`} size="lg" titleText={filter.label} hideLabel label={filter.label}
        items={filter.options} selectedItem={filter.options.find(item => item.value === selected)} itemToString={item => item?.label ?? ''}
        onChange={({ selectedItem }) => { setSelected(selectedItem?.value ?? ''); setPage(1); }}
        translateWithId={key => t(key === 'close.menu' ? 'common.closeOptions' : 'common.openOptions', { name: '' })} /></div>}
      {onRefresh && <Button variant="ghost" size="lg" disabled={refreshing} onClick={onRefresh}><RefreshCw aria-hidden="true" />{t('resourceList.refresh')}</Button>}
      {action}
    </div>
    <div className="resource-list-summary">
      <span role="status">{loading ? t('resourceList.loading') : error ? t('resourceList.unavailable') : t('resourceList.count', { matched: filtered.length, total: items.length })}</span>
      {active ? <Button variant="ghost" size="sm" onClick={clear}>{t('resourceList.clearFilters')}</Button> : summary}
    </div>
    {loading ? <div className="p-5"><Skeleton className="h-48" /></div> : error ? <div className="p-5 space-y-3"><ErrorNotice error={error} />{onRefresh && <Button variant="outline" disabled={refreshing} onClick={onRefresh}>{t('common.retry')}</Button>}</div> : !filtered.length ? <div className="p-8"><EmptyState title={active ? t('resourceList.noMatches') : emptyTitle} description={active ? t('resourceList.noMatchesDescription') : emptyDescription} action={active ? <Button variant="outline" onClick={clear}>{t('resourceList.clearFilters')}</Button> : undefined} /></div> : children(filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize))}
    {!loading && !error && filtered.length > 0 && <Pagination size="md" totalItems={filtered.length} page={currentPage} pageSize={pageSize} pageSizes={[25, 50, 100]}
      onChange={({ page: next, pageSize: size }) => { setPage(size === pageSize ? next : 1); setPageSize(size); }}
      itemsPerPageText={t('resourceList.perPage')} backwardText={t('resourceList.previous')} forwardText={t('resourceList.next')}
      pageNumberText={t('resourceList.page')} pageSelectLabelText={() => t('resourceList.page')}
      itemRangeText={(min, max, total) => t('resourceList.range', { min, max, total })} pageRangeText={(_page, total) => t('resourceList.pages', { total })} />}
  </section>;
}
