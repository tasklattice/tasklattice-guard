import { useTranslation } from "react-i18next";
import { Checkbox as CarbonCheckbox } from "@/components/ui/checkbox";
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { QueryBuilder, type RuleGroupType, type ValueEditorProps, type ActionProps } from 'react-querybuilder';
import { QueryBuilderCarbon } from '@/components/query-builder';
import 'react-querybuilder/dist/query-builder.css';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field, NativeSelect } from './form';
import { selectorFields, selectableSelectorFields } from '../../../shared/traffic-routing';
import type { SelectorCondition, SelectorExpression, SelectorField } from '@/lib/traffic-routing-api';

export const newCondition = (): SelectorCondition => ({ field: 'http.header', key: '', requestSource: 'business_request', operator: 'equals', value: '', caseSensitive: true });
export const leafCount = (group: SelectorExpression): number => group.conditions.reduce((n, c) => n + ("conditions" in c ? leafCount(c) : 1), 0);
const defaultSelectorFields = selectableSelectorFields([]);
export function SelectorEditor({ value, onChange, fields = defaultSelectorFields }: { value: SelectorExpression; onChange: (value: SelectorExpression) => void; fields?: SelectorField[] }) {
  const { t } = useTranslation();
  // Preserve QueryBuilder's node IDs while editing; rebuilding from the domain
  // expression on each keystroke remounts rule inputs and drops their focus.
  const [query, setQuery] = useState(() => toQuery(value));
  const acceptedValue = useRef(value);
  useEffect(() => {
    if (JSON.stringify(value) !== JSON.stringify(acceptedValue.current)) {
      acceptedValue.current = value;
      setQuery(toQuery(value));
    }
  }, [value]);
  const total = leafCount(value);
  return <QueryBuilderCarbon><QueryBuilder
    fields={fields.map(field => ({ name: field.id, label: field.label }))}
    query={query}
    onQueryChange={nextQuery => {
      const nextValue = fromQuery(nextQuery);
      setQuery(nextQuery);
      acceptedValue.current = nextValue;
      onChange(nextValue);
    }}
    getOperators={name => (fields.find(field => field.id === name)?.operators ?? []).map(operator => ({ name: operator, label: operator }))}
    getDefaultValue={() => ({ key: '', requestSource: 'endpoint_request', value: '', caseSensitive: true })}
    combinators={[{ name: 'and', label: t("routing.allAND") }, { name: 'or', label: t("routing.anyOR") }]}
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
      addRule: { label: t("routing.addCondition") },
      addGroup: { label: t("routing.addGroup") },
      removeRule: { label: t("routing.removeCondition") },
      removeGroup: { label: t("routing.removeGroup") },
    }}
  /></QueryBuilderCarbon>;
}
export function toQuery(expression: SelectorExpression): RuleGroupType {
  return { id: crypto.randomUUID(), combinator: expression.combinator, rules: expression.conditions.map(condition =>
    "conditions" in condition ? toQuery(condition) : {
      id: crypto.randomUUID(), field: condition.field, operator: condition.operator,
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
  const { t } = useTranslation();
  const field = fields.find(f => f.id === value.field) ?? selectorFields.find(f => f.id === value.field);
  const multiple = value.operator === 'in' || value.operator === 'not_in';
  const noValue = value.operator === 'exists' || value.operator === 'not_exists';
  const values = Array.isArray(value.value) ? value.value : [value.value];
  return <div className="router-selector-value grid min-w-0 gap-3 sm:grid-cols-2">
    {field?.http && <Field label={t("routing.hTTPSource")}><NativeSelect value={value.requestSource ?? ''} onChange={e => onChange({ ...value, requestSource: e.target.value as SelectorCondition['requestSource'] })}><option value="" disabled>{t("routing.chooseSource")}</option><option value="endpoint_request">{t("routing.endpointRequest")}</option><option value="business_request">{t("routing.originalBusinessRequest")}</option></NativeSelect></Field>}
    {field?.customKey && <Field label={value.field === 'http.header' ? t("routing.headerName") : t("routing.attributeKey")}><Input className="field:min-h-11" value={value.key ?? ''} onChange={e => onChange({ ...value, key: value.field === 'http.header' ? e.target.value.toLowerCase() : e.target.value })} placeholder={value.field === 'http.header' ? 'x-channel' : ''} /></Field>}
    {!noValue && (multiple ? <div className="grid gap-2 sm:col-span-2">{values.map((v, i) => <div key={i} className="flex items-end gap-2"><div className="min-w-0 flex-1"><Field label={`${t("routing.value")} ${i + 1}`}><Input className="field:min-h-11" value={v} onChange={e => onChange({ ...value, value: values.map((s, n) => n === i ? e.target.value : s) })} /></Field></div><Button className="min-h-11" variant="destructive" aria-label={`${t("routing.removeValue")} ${i + 1}`} onClick={() => onChange({ ...value, value: values.filter((_, n) => n !== i) })}>−</Button></div>)}<Button type="button" className="min-h-11 justify-self-start" variant="create" onClick={() => onChange({ ...value, value: [...values, ''] })}>{t("routing.addValue")}</Button></div> : <Field label={t("routing.value")}><Input className="field:min-h-11" value={values[0] ?? ''} onChange={e => onChange({ ...value, value: e.target.value })} /></Field>)}
    {!noValue && <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2"><CarbonCheckbox checked={value.caseSensitive !== false} onChange={e => onChange({ ...value, caseSensitive: e.target.checked })} />{t("routing.caseSensitive")}</label>}
  </div>;
}

function SelectorAction({ className, handleOnClick, label, title, disabled, testID }: ActionProps) {
  const remove = testID === 'remove-rule' || testID === 'remove-group';
  return <Button type="button" variant={remove ? 'destructive' : 'create'}
    size={remove ? 'icon' : 'default'}
    className={className} disabled={disabled} data-testid={testID}
    aria-label={typeof label === 'string' ? label : title} title={title}
    onClick={handleOnClick}>
    {remove ? <Trash2 className="size-4" /> : <><Plus className="size-4" />{label}</>}
  </Button>;
}
