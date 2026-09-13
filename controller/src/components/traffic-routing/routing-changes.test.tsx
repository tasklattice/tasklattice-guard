import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Changes, routingSnapshotText } from './routing-changes';
import type { RouterDraft } from '@/lib/traffic-routing-api';
afterEach(cleanup);
const before: RouterDraft = { routes: [{ id: 'r', name: 'HTTP route', kind: 'normal', enabled: true, selector: { expression: { combinator: 'and', conditions: [{ field: 'http.host', operator: 'equals', value: 'old.example' }] } }, targets: [{ id: 'a', guardrailId: 'g', guardrailVersion: 'v1', weightBps: 10000 }] }] };
it('renders both removed and added values using the real diff viewer', async () => {
 const after = structuredClone(before); after.routes[0]!.targets[0]!.guardrailVersion = 'v2';
 render(<Changes before={before} after={after} names={[]} />);
 await waitFor(() => expect(screen.getByRole('table').textContent).toContain('v1'));
 expect(screen.getByRole('table').textContent).toContain('v2');
 expect(screen.getByText('+ Added · red')).toBeTruthy();
 expect(screen.getByText('− Removed · green')).toBeTruthy();
});
it('preserves order, complete selectors, identities and weights in the compared text', () => {
 const text = routingSnapshotText(before, [{id: 'g', name: 'Main Guardrail'}]);
 expect(text).toContain('old.example'); expect(text).toContain('"position": 1');
 expect(text).toContain('Main Guardrail'); expect(text).toContain('100%');
 expect(text).toContain('"guardrailId": "g"');
 expect(routingSnapshotText(null, [])).toBe('');
});
it('shows a clear unchanged state', () => {
 render(<Changes before={before} after={structuredClone(before)} names={[]} />);
 expect(screen.getByText('No routing changes.')).toBeTruthy();
});
