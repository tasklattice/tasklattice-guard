import { lazy, Suspense } from 'react';
import type { RouterDraft } from '@/lib/traffic-routing-api';
import { routingDiff } from './router-view-model';

const DiffViewer = lazy(() => import('react-diff-viewer-continued'));

export function routingSnapshotText(snapshot: RouterDraft | null, names: Array<{ id: string; name: string }>): string {
  if (!snapshot) return '';
  return JSON.stringify(snapshot.routes.map((route, index) => ({
    position: index + 1,
    ...route,
    targets: route.targets.map(target => ({
      ...target,
      guardrailName: names.find(name => name.id === target.guardrailId)?.name ?? target.guardrailId,
      percentage: `${target.weightBps / 100}%`,
    })),
  })), null, 2);
}

// Product convention: additions are red, removals green. Keep +/- markers
// and an explicit legend, since this differs from conventional Git colors.
const colors = {
  diffViewerBackground: 'var(--card)', diffViewerColor: 'var(--foreground)',
  addedBackground: 'color-mix(in srgb, var(--destructive) 12%, var(--card))',
  addedColor: 'var(--foreground)',
  removedBackground: 'color-mix(in srgb, #16a34a 12%, var(--card))',
  removedColor: 'var(--foreground)',
  wordAddedBackground: 'color-mix(in srgb, var(--destructive) 28%, var(--card))',
  wordRemovedBackground: 'color-mix(in srgb, #16a34a 28%, var(--card))',
  addedGutterBackground: 'color-mix(in srgb, var(--destructive) 18%, var(--card))',
  removedGutterBackground: 'color-mix(in srgb, #16a34a 18%, var(--card))',
  gutterBackground: 'var(--muted)', gutterColor: 'var(--muted-foreground)',
  addedGutterColor: 'var(--foreground)', removedGutterColor: 'var(--foreground)',
  codeFoldBackground: 'var(--muted)', codeFoldContentColor: 'var(--muted-foreground)',
};
export function Changes({ before, after, names }: { before: RouterDraft | null; after: RouterDraft; names: Array<{ id: string; name: string }> }) {
  const changes = routingDiff(before, after);
  if (!changes.length) return <p className="text-sm text-muted-foreground">No routing changes.</p>;
  return <section className="min-w-0 space-y-3" aria-label="Routing configuration diff">
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <h3 className="font-medium">Routing changes · {changes.length}</h3>
      <div className="flex gap-3 text-xs"><span className="rounded bg-destructive/15 px-2 py-1">+ Added · red</span><span className="rounded bg-green-600/15 px-2 py-1">− Removed · green</span></div>
    </div>
    <p className="text-xs text-muted-foreground">Before → After · Line numbers show the previous and proposed configuration.</p>
    <div className="min-w-0 overflow-x-auto rounded-lg border text-xs [&_table]:w-full [&_table]:table-fixed [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]">
      <Suspense fallback={<p role="status" className="p-4">Loading changes…</p>}>
        <DiffViewer oldValue={routingSnapshotText(before, names)} newValue={routingSnapshotText(after, names)} splitView={false} hideSummary showDiffOnly extraLinesSurroundingDiff={2} useDarkTheme={false} styles={{
          variables: { light: colors, dark: colors },
          diffContainer: { minWidth: 0, width: "100%", tableLayout: "fixed" },
          contentText: { fontFamily: 'var(--font-mono, monospace)', fontSize: '12px', lineHeight: '1.7', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
          gutter: { width: '2.5rem', minWidth: '2.5rem', padding: '0 4px' },
          marker: { width: '1.25rem', padding: '0 4px' },
        }} />
      </Suspense>
    </div>
  </section>;
}
