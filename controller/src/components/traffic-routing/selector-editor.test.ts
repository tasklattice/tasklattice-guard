import { describe, expect, it } from 'vitest';
import { fromQuery, toQuery } from './selector-editor';
import { distributeEqually } from './targets-editor';
import type { SelectorExpression } from '@/lib/traffic-routing-api';

describe('routing editor domain conversion', () => {
  it('preserves nested groups, Header source, repeated values and case sensitivity', () => {
    const expression: SelectorExpression = { combinator: 'or', conditions: [
      { combinator: 'and', conditions: [{ field: 'http.header', key: 'x-agent', requestSource: 'business_request', operator: 'in', value: ['one', 'two'], caseSensitive: false }] },
      { field: 'model', operator: 'equals', value: 'model-a', caseSensitive: true },
    ] };
    expect(fromQuery(toQuery(expression))).toEqual(expression);
  });
  it('keeps percentage totals exact when adding or removing targets', () => {
    const targets = ['a', 'b', 'c'].map(id => ({ id, guardrailId: id, guardrailVersion: '1', weightBps: 0 }));
    expect(distributeEqually(targets).map(target => target.weightBps)).toEqual([3334, 3333, 3333]);
    expect(distributeEqually(targets.slice(0, 1))[0]?.weightBps).toBe(10000);
  });
});
