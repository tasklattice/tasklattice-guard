import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function useEventCursor(scope: string) {
  const [state, setState] = useState<{ scope: string; history: Array<string | undefined> }>({ scope, history: [undefined] });
  const history = state.scope === scope ? state.history : [undefined];
  if (state.scope !== scope) setState({ scope, history });
  return {
    cursor: history.at(-1), page: history.length,
    next: (cursor: string) => setState({ scope, history: [...history, cursor] }),
    previous: () => setState({ scope, history: history.length > 1 ? history.slice(0, -1) : history }),
    latest: () => setState({ scope, history: [undefined] }),
  };
}

export function EventPagination({ page, busy, nextCursor, onNext, onPrevious, onLatest, pageSize, onPageSizeChange, itemCount, allowRefresh = false, casePages = false }: {
  page: number; busy: boolean; nextCursor?: string | null | undefined;
  onNext: (cursor: string) => void; onPrevious: () => void; onLatest: () => void;
  pageSize?: 25 | 50; onPageSizeChange?: (size: 25 | 50) => void;
  itemCount?: number; allowRefresh?: boolean; casePages?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return <nav aria-label={t(casePages ? 'validation.caseResults' : 'eventPagination.label')} className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
    <span className="mr-auto text-xs text-muted-foreground">{t('eventPagination.page', { page })}{itemCount !== undefined ? ` · ${t(casePages ? 'casePagination.count' : 'securityEvents.pageCount', { count: itemCount })}` : ''}</span>
    {pageSize && onPageSizeChange ? <label htmlFor={id} className="mr-3 flex items-center gap-2 text-xs text-muted-foreground">{t('securityEvents.perPage')}<select id={id} className="h-11 border bg-background px-3 text-sm text-foreground" value={pageSize} disabled={busy} onChange={event => onPageSizeChange(Number(event.target.value) as 25 | 50)}><option value={25}>25</option><option value={50}>50</option></select></label> : null}
    <Button variant="outline" disabled={busy || (!allowRefresh && page === 1)} onClick={onLatest}>{t(casePages ? 'casePagination.first' : 'eventPagination.latest')}</Button>
    <Button variant="outline" disabled={busy || page === 1} onClick={onPrevious}>{t(casePages ? 'common.previous' : 'eventPagination.previous')}</Button>
    <Button variant="outline" disabled={busy || !nextCursor} onClick={() => { if (nextCursor) onNext(nextCursor); }}>{t(casePages ? 'common.next' : 'eventPagination.next')}</Button>
  </nav>;
}
