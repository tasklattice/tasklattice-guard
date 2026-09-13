import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SelectorEditor } from './selector-editor';
import type { SelectorExpression } from '@/lib/traffic-routing-api';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
afterEach(cleanup);
function Harness({ initial }: { initial: SelectorExpression }) {
  const [value, setValue] = useState(initial);
  return <><SelectorEditor value={value} onChange={setValue} /><button onClick={() => setValue({ combinator: 'and', conditions: [{ field: 'endpoint.id', operator: 'equals', value: 'replacement' }] })}>Reload selector</button></>;
}
it.each([false, true])('keeps the same focused input across consecutive changes (nested=%s)', nested => {
  const condition = { field: 'endpoint.id', operator: 'equals' as const, value: '' };
  render(<Harness initial={{ combinator: 'and', conditions: nested ? [{ combinator: 'or', conditions: [condition] }] : [condition] }} />);
  const input = screen.getByLabelText('Value') as HTMLInputElement;
  input.focus();
  for (const value of ['d', 'de', 'dev', 'development']) {
    fireEvent.change(input, { target: { value } });
    expect(screen.getByLabelText('Value')).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(value);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Reload selector' }));
  expect((screen.getByLabelText('Value') as HTMLInputElement).value).toBe('replacement');
});
it.each(['Header name', 'Value 1'])('preserves focus in %s controls', label => {
  render(<Harness initial={{ combinator: 'and', conditions: [{ field: 'http.header', key: 'x-env', requestSource: 'business_request', operator: 'in', value: ['dev', 'prod'], caseSensitive: false }] }} />);
  const input = screen.getByLabelText(label) as HTMLInputElement;
  input.focus();
  for (const value of ['a', 'ab', 'abc']) {
    fireEvent.change(input, { target: { value } });
    expect(screen.getByLabelText(label)).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(value);
  }
});
