import { Plus, Trash2 } from 'lucide-react';
import { QueryBuilder, type RuleGroupType, type ValueEditorProps, type ActionProps } from 'react-querybuilder';
import { QueryBuilderShadcn } from '@/components/query-builder';
import 'react-querybuilder/dist/query-builder.css';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field, NativeSelect, useRoutingText } from './form';
import { selectorFields } from '../../../shared/traffic-routing';
import type { SelectorCondition, SelectorExpression, SelectorField } from '@/lib/traffic-routing-api';

export const newCondition = (): SelectorCondition => ({ field: 'http.header', key: '', requestSource: 'business_request', operator: 'equals', value: '', caseSensitive: true });
export const leafCount = (group: SelectorExpression): number => group.conditions.reduce((n, c) => n + ('conditions' in c ? leafCount(c) : 1), 0);
export function SelectorEditor({ value, onChange, fields = selectorFields }: { value: SelectorExpression; onChange: (value: SelectorExpression) => void; fields?: SelectorField[] }) {
  const t = useRoutingText();
  const total = leafCount(value);
  return <QueryBuilderShadcn><QueryBuilder
    fields={fields.map(field => ({ name: field.id, label: field.label }))}
    query={toQuery(value)}
    onQueryChange={query => onChange(fromQuery(query))}
    getOperators={name => (fields.find(field => field.id === name)?.operators ?? []).map(operator => ({ name: operator, label: operator }))}
    getDefaultValue={() => ({ key: '', requestSource: 'endpoint_request', value: '', caseSensitive: true })}
    combinators={[{ name: 'and', label: t('全部满足 · AND', 'All · AND') }, { name: 'or', label: t('任一满足 · OR', 'Any · OR') }]}
    controlElements={{ valueEditor: SelectorValueEditor, actionElement: SelectorAction }}
    context={{ fields }}
    resetOnFieldChange
    resetOnOperatorChange={false}
    maxLevels={3}
    onAddRule={() => total < 16}
    onAddGroup={() => total < 16}
    addRuleToNewGroups
    controlClassnames={{
      queryBuilder: 'traffic-scope-query-builder router-selector queryBuilder-branches',
      ruleGroup: 'space-y-3 rounded-lg border p-3',
      header: 'flex flex-wrap items-center gap-2',
      body: 'space-y-3',
      rule: 'rounded-md border bg-background p-3',
      fields: 'router-selector-field', operators: 'router-selector-operator',
      removeRule: 'router-selector-remove',
    }}
    translations={{
      addRule: { label: t('添加条件', 'Add condition') },
      addGroup: { label: t('添加条件组', 'Add group') },
      removeRule: { label: t('删除条件', 'Remove condition') },
      removeGroup: { label: t('删除条件组', 'Remove group') },
    }}
  /></QueryBuilderShadcn>;
}
export function toQuery(expression: SelectorExpression): RuleGroupType {
  return { combinator: expression.combinator, rules: expression.conditions.map(condition =>
    'conditions' in condition ? toQuery(condition) : {
      field: condition.field, operator: condition.operator,
      value: { key: condition.key, requestSource: condition.requestSource, value: condition.value, caseSensitive: condition.caseSensitive },
    }) };
}
export function fromQuery(query: RuleGroupType): SelectorExpression {
  return { combinator: query.combinator === 'or' ? 'or' : 'and', conditions: query.rules.map(rule => {
    if ('rules' in rule) return fromQuery(rule);
    const field = selectorFields.find(item => item.id === rule.field);
    const encoded = rule.value && typeof rule.value === 'object' ? rule.value : {};
    const multiple = rule.operator === 'in' || rule.operator === 'not_in';
    const raw = encoded.value ?? '';
    return {
      field: rule.field, operator: rule.operator as SelectorCondition['operator'],
      ...(field?.customKey ? { key: encoded.key ?? '' } : {}),
      ...(field?.http ? { requestSource: encoded.requestSource ?? 'endpoint_request' } : {}),
      caseSensitive: encoded.caseSensitive !== false,
      value: multiple ? (Array.isArray(raw) ? raw : [raw]) : (Array.isArray(raw) ? raw[0] ?? '' : raw),
    };
  }) };
}
function SelectorValueEditor(props: ValueEditorProps) {
  const expression = fromQuery({ combinator: 'and', rules: [{ field: props.field, operator: props.operator, value: props.value }] });
  const value = expression.conditions[0] as SelectorCondition;
  return <Condition value={value} fields={props.context.fields} onChange={next => props.handleOnChange({
    key: next.key, requestSource: next.requestSource, value: next.value, caseSensitive: next.caseSensitive,
  })} />;
}
function Condition({ value, fields, onChange }: { value: SelectorCondition; fields: SelectorField[]; onChange: (v: SelectorCondition) => void }) {
  const t = useRoutingText();
  const field = fields.find(f => f.id === value.field) ?? selectorFields.find(f => f.id === value.field);
  const multiple = value.operator === 'in' || value.operator === 'not_in';
  const noValue = value.operator === 'exists' || value.operator === 'not_exists';
  const values = Array.isArray(value.value) ? value.value : [value.value];
  return <div className="router-selector-value grid min-w-0 gap-3 sm:grid-cols-2">
    {field?.http && <Field label={t('HTTP 来源', 'HTTP source')}><NativeSelect value={value.requestSource ?? ''} onChange={e => onChange({ ...value, requestSource: e.target.value as SelectorCondition['requestSource'] })}><option value="" disabled>{t('选择来源', 'Choose source')}</option><option value="endpoint_request">{t('Endpoint 接入请求', 'Endpoint request')}</option><option value="business_request">{t('原始业务请求', 'Original business request')}</option></NativeSelect></Field>}
    {field?.customKey && <Field label={value.field === 'http.header' ? t('Header 名称', 'Header name') : t('属性名称', 'Attribute key')}><Input className="min-h-11" value={value.key ?? ''} onChange={e => onChange({ ...value, key: value.field === 'http.header' ? e.target.value.toLowerCase() : e.target.value })} placeholder={value.field === 'http.header' ? 'x-channel' : ''} /></Field>}
    {!noValue && (multiple ? <div className="grid gap-2 sm:col-span-2">{values.map((v, i) => <div key={i} className="flex items-end gap-2"><div className="min-w-0 flex-1"><Field label={`${t('值', 'Value')} ${i + 1}`}><Input className="min-h-11" value={v} onChange={e => onChange({ ...value, value: values.map((s, n) => n === i ? e.target.value : s) })} /></Field></div><Button className="min-h-11" variant="outline" aria-label={`${t('删除值', 'Remove value')} ${i + 1}`} onClick={() => onChange({ ...value, value: values.filter((_, n) => n !== i) })}>−</Button></div>)}<Button type="button" className="min-h-11 justify-self-start" variant="outline" onClick={() => onChange({ ...value, value: [...values, ''] })}>{t('添加值', 'Add value')}</Button></div> : <Field label={t('值', 'Value')}><Input className="min-h-11" value={values[0] ?? ''} onChange={e => onChange({ ...value, value: e.target.value })} /></Field>)}
    {!noValue && <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={value.caseSensitive !== false} onChange={e => onChange({ ...value, caseSensitive: e.target.checked })} />{t('区分大小写', 'Case sensitive')}</label>}
  </div>;
}

function SelectorAction({ className, handleOnClick, label, title, disabled, testID }: ActionProps) {
  const remove = testID === 'remove-rule' || testID === 'remove-group';
  return <Button type="button" variant={remove ? 'ghost' : 'outline'}
    className={className} disabled={disabled} data-testid={testID}
    aria-label={typeof label === 'string' ? label : title} title={title}
    onClick={handleOnClick}>
    {remove ? <Trash2 className="size-4" /> : <><Plus className="size-4" />{label}</>}
  </Button>;
}
