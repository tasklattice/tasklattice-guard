import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { SelectorEditor } from './selector-editor';
import { capabilityIssues, selectorExpressionSchema, selectableSelectorFields, type SelectorExpression, type RouterDraft } from '../../../shared/traffic-routing';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(cleanup);

const endpoints = [{ id: 'litellm', adapter: 'LITELLM' }];
function Harness() {
  const [value, setValue] = useState<SelectorExpression>({ combinator: 'and', conditions: [] });
  return <><SelectorEditor value={value} fields={selectableSelectorFields(endpoints)} onChange={setValue} /><output data-testid="expression">{JSON.stringify(value)}</output></>;
}
const currentExpression = (): SelectorExpression => JSON.parse(screen.getByTestId('expression').textContent!);
const draftFor = (expression: SelectorExpression): RouterDraft => ({ routes: [{ id: 'route', name: 'Route', kind: 'normal', enabled: true, selector: { expression }, targets: [] }] });
async function select(testId: string, name: string) {
  fireEvent.keyDown(screen.getByTestId(testId), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name, exact: true }));
}

it.each(['protocol', 'litellm.team_id', 'litellm.api_key_alias', 'litellm.user_id'])('creates and switches a real selector dropdown to %s for LiteLLM', async field => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
  // Switching from an HTTP field must not leak its key/source into LiteLLM conditions.
  await select('fields', 'HTTP Header');
  fireEvent.change(screen.getByLabelText('Header name'), { target: { value: 'x-team' } });
  await select('fields', field);
  const value = field === 'protocol' ? 'litellm' : 'team-a';
  fireEvent.change(screen.getByLabelText('Value'), { target: { value } });
  const expression = currentExpression();
  expect(selectorExpressionSchema.safeParse(expression).success).toBe(true);
  expect(expression.conditions[0]).toEqual({ field, operator: 'equals', value, caseSensitive: true });
  expect(capabilityIssues(draftFor(expression), endpoints)).toEqual([]);
});

it.each(['in', 'not_in', 'exists', 'not_exists'])('serializes the %s operator after choosing a LiteLLM field', async operator => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
  await select('fields', 'litellm.team_id');
  await select('operators', operator);
  if (operator === 'in' || operator === 'not_in') {
    fireEvent.change(screen.getByLabelText('Value 1'), { target: { value: 'team-a' } });
  }
  const expression = currentExpression();
  expect(selectorExpressionSchema.safeParse(expression).success).toBe(true);
  expect(expression.conditions[0]).toMatchObject({ field: 'litellm.team_id', operator });
  expect(capabilityIssues(draftFor(expression), endpoints)).toEqual([]);
});

it('hides unsupported LiteLLM fields and still rejects unsupported saved conditions', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
  fireEvent.keyDown(screen.getByTestId('fields'), { key: 'ArrowDown' });
  expect(await screen.findByRole('option', { name: 'litellm.team_id', exact: true })).toBeTruthy();
  for (const name of ['a2a.version', 'litellm.version', 'output.sink', 'output.content_type', 'output.schema_id', 'JWT Claim', 'Request attribute']) {
    expect(screen.queryByRole('option', { name, exact: true })).toBeNull();
  }
  const expression: SelectorExpression = { combinator: 'and', conditions: [{ field: 'a2a.version', operator: 'equals', value: '1.0' }] };
  expect(selectorExpressionSchema.safeParse(expression).success).toBe(true);
  expect(capabilityIssues(draftFor(expression), endpoints)).toEqual([
    'Route: litellm does not supply a2a.version at first_assignment (selector.expression.conditions.0)',
  ]);
});
