import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function useEventCursor(scope: string) {
  const [state, setState] = useState<{ scope: string; history: Array<string | undefined> }>({ scope, history: [undefined] });
  const history = state.scope === scope ? state.history : [undefined];
  return {
    cursor: history.at(-1), page: history.length,
    next: (cursor: string) => setState({ scope, history: [...history, cursor] }),
    previous: () => setState({ scope, history: history.length > 1 ? history.slice(0, -1) : history }),
    latest: () => setState({ scope, history: [undefined] }),
  };
}

export function EventPagination({ page, busy, nextCursor, onNext, onPrevious, onLatest }: {
  page: number; busy: boolean; nextCursor?: string | null | undefined;
  onNext: (cursor: string) => void; onPrevious: () => void; onLatest: () => void;
}) {
  const { t } = useTranslation();
  return <nav aria-label={t('eventPagination.label')} className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
    <span className="mr-auto text-xs text-muted-foreground">{t('eventPagination.page', { page })}</span>
    <Button variant="outline" disabled={busy || page === 1} onClick={onLatest}>{t('eventPagination.latest')}</Button>
    <Button variant="outline" disabled={busy || page === 1} onClick={onPrevious}>{t('eventPagination.previous')}</Button>
    <Button variant="outline" disabled={busy || !nextCursor} onClick={() => { if (nextCursor) onNext(nextCursor); }}>{t('eventPagination.next')}</Button>
  </nav>;
}
