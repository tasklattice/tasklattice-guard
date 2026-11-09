import type { DefinitionRule, PolicyDefinition } from "../../shared/policy-definition";
import { modelParameterFields, parameterReference, parameterReferenceName, parameterReferences, type ModelParameterField } from "../../shared/policy-parameters";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";

type Translate = (key: string) => string;

/** New model Rules declare their configurable inputs instead of embedding business values. */
export function withModelParameters(definition: PolicyDefinition, rule: DefinitionRule, l: Translate): PolicyDefinition {
  const parameters = [...definition.parameters];
  const values = { ...rule.detector.parameters };
  for (const field of modelParameterFields(rule)) {
    let name = field.name;
    let suffix = 2;
    while (parameters.some(p => p.name === name && p.kind !== field.kind)) name = `${field.name}_${suffix++}`;
    if (!parameters.some(p => p.name === name)) parameters.push({ name, label: l(field.key), kind: field.kind, required: field.required, default: field.default, description: "", placeholder: "" });
    values[field.key] = parameterReference(name);
  }
  return { ...definition, parameters, rules: definition.rules.map(item => item.id === rule.id ? { ...rule, detector: { ...rule.detector, parameters: values } } : item) };
}

function renameParameter(definition: PolicyDefinition, name: string, next: string): PolicyDefinition {
  const replace = (value: unknown): unknown => typeof value === "string" ? value.replaceAll(parameterReference(name), parameterReference(next))
    : Array.isArray(value) ? value.map(replace) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "parameter" && item === name ? next : replace(item)])) : value;
  const changed = replace(definition) as PolicyDefinition;
  return { ...changed, parameters: changed.parameters.map(p => p.name === name ? { ...p, name: next } : p),
    tests: changed.tests.map(test => ({ ...test, parameter_names: test.parameter_names.map(n => n === name ? next : n) })),
    ...(definition.testing ? { testing: { parameters: Object.fromEntries(Object.entries(definition.testing.parameters).map(([key, value]) => [key === name ? next : key, value])) } } : {}),
  };
}

export function PolicyParameterEditor({ definition, change, l }: { definition: PolicyDefinition; change: (value: PolicyDefinition) => void; l: Translate }) {
  const update = (index: number, patch: Partial<PolicyDefinition["parameters"][number]>) => change({ ...definition, parameters: definition.parameters.map((p, i) => i === index ? { ...p, ...patch } : p) });
  return <section className="mb-5 space-y-4 border-b pb-5" aria-label={l("guardrailParameters")}>
    <div className="flex items-start justify-between gap-4"><div><h3 className="text-sm font-semibold">{l("guardrailParameters")}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{l("guardrailParametersHint")}</p></div>
      <Button variant="outline" className="min-h-11 shrink-0" onClick={() => {
        let index = 1; while (definition.parameters.some(p => p.name === `parameter_${index}`)) index++;
        change({ ...definition, parameters: [...definition.parameters, { name: `parameter_${index}`, label: "", kind: "text", required: true, default: null, description: "", placeholder: "" }] });
      }}><Plus />{l("addParameter")}</Button>
    </div>
    {definition.parameters.map((parameter, index) => {
      const usesParameter = (value: unknown): boolean => typeof value === "string" ? parameterReferences(value).includes(parameter.name)
        : Array.isArray(value) ? value.some(usesParameter) : !!value && typeof value === "object" && Object.entries(value).some(([key, item]) => key === "parameter" && item === parameter.name || usesParameter(item));
      const used = definition.rules.some(usesParameter)
        || definition.tests.some(test => JSON.stringify(test).includes(parameterReference(parameter.name)) || test.parameter_names.includes(parameter.name));
      return <div key={index} className="space-y-3 rounded-lg border p-3">
        <div className="grid grid-cols-4 gap-3">
          <label className="grid gap-2 text-xs">{l("parameterName")}<Input value={parameter.name} onChange={e => change(renameParameter(definition, parameter.name, e.target.value))} /></label>
          <label className="grid gap-2 text-xs">{l("parameterLabel")}<Input value={parameter.label} onChange={e => update(index, { label: e.target.value })} /></label>
          <label className="grid gap-2 text-xs">{l("parameterType")}<NativeSelect className="min-h-11" value={parameter.kind} onChange={e => update(index, { kind: e.target.value })}>{[...new Set(["text", "textarea", "number", parameter.kind])].map(kind => <option key={kind} value={kind}>{l(`parameterType_${kind}`)}</option>)}</NativeSelect></label>
          <label className="grid gap-2 text-xs">{l("parameterDefault")}<Input disabled={parameter.kind === "secret"} value={parameter.default ?? ""} onChange={e => update(index, { default: e.target.value || null })} /></label>
        </div>
        <div className="flex items-center justify-between gap-3"><label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={parameter.required} onChange={e => update(index, { required: e.target.checked })} />{l("parameterRequired")}</label>
          <div className="flex items-center gap-3">{used ? <span className="text-xs text-muted-foreground">{l("parameterInUse")}</span> : null}<Button size="icon" variant="ghost" className="size-11" disabled={used} aria-label={`${l("removeParameter")} ${parameter.name}`} onClick={() => {
            const testing = { ...definition.testing?.parameters }; delete testing[parameter.name];
            change({ ...definition, parameters: definition.parameters.filter((_, i) => i !== index), ...(definition.testing ? { testing: { parameters: testing } } : {}) });
          }}><Trash2 /></Button></div>
        </div>
      </div>;
    })}
  </section>;
}

export function ModelParameterInput({ field, value, parameters, update, l }: { field: ModelParameterField; value: unknown; parameters: PolicyDefinition["parameters"]; update: (value: string) => void; l: Translate }) {
  const reference = parameterReferenceName(value);
  const matching = parameters.filter(p => field.kind === "number" ? p.kind === "number" : ["text", "textarea"].includes(p.kind));
  const label = l(field.key);
  return <div className="space-y-2">
    <label className="grid gap-2 text-xs font-medium">{label}<NativeSelect className="min-h-11" value={reference ?? "__fixed__"} onChange={e => update(e.target.value === "__fixed__" ? field.default ?? "" : parameterReference(e.target.value))}>
      <option value="__fixed__">{l("fixedValue")}</option>
      {reference && !matching.some(p => p.name === reference) ? <option value={reference}>{reference}</option> : null}
      {matching.map(p => <option key={p.name} value={p.name}>{l("parameterReference")} · {p.label || p.name} ({p.name})</option>)}
    </NativeSelect></label>
    {reference ? <p className="text-xs text-muted-foreground">{l("configuredInGuardrail")} <code>{parameterReference(reference)}</code></p>
      : field.key === "topic_mode" ? <NativeSelect className="min-h-11 w-full" aria-label={`${label} · ${l("fixedValue")}`} value={String(value ?? field.default ?? "")} onChange={e => update(e.target.value)}><option value="permissive">{l("permissive")}</option><option value="strict">{l("strict")}</option></NativeSelect>
      : field.kind === "textarea" ? <Textarea aria-label={`${label} · ${l("fixedValue")}`} value={String(value ?? "")} onChange={e => update(e.target.value)} />
      : <Input aria-label={`${label} · ${l("fixedValue")}`} type={field.kind === "number" ? "number" : "text"} step="any" value={String(value ?? field.default ?? "")} onChange={e => update(e.target.value)} />}
  </div>;
}

export function PolicyTestParameters({ definition, change, l }: { definition: PolicyDefinition; change: (definition: PolicyDefinition) => void; l: Translate }) {
  const parameters = definition.parameters.filter(p => p.kind !== "secret");
  if (!parameters.length) return null;
  return <section className="mb-5 space-y-3 rounded-lg border p-4" aria-label={l("testParameters")}>
    <h3 className="text-sm font-semibold">{l("testParameters")}</h3><p className="text-xs leading-5 text-muted-foreground">{l("testParametersHint")}</p>
    <div className="grid grid-cols-2 gap-4">{parameters.map(p => {
      const props = { value: definition.testing?.parameters[p.name] ?? p.default ?? "", onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change({ ...definition, testing: { parameters: { ...definition.testing?.parameters, [p.name]: event.target.value } } }) };
      return <label key={p.name} className="grid gap-2 text-xs">{`${p.label || p.name} · ${l("testValue")}`}{p.kind === "textarea" ? <Textarea {...props} /> : <Input type={p.kind === "number" ? "number" : "text"} step="any" {...props} />}</label>;
    })}</div>
  </section>;
}
