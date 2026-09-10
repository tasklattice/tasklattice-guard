import { AlertTriangle, ListFilter, Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  QueryBuilder,
  type ActionProps,
  type Field,
  type ValueEditorProps,
} from "react-querybuilder";
import "react-querybuilder/dist/query-builder.css";
import { toast } from "sonner";

import { QueryBuilderShadcn, ShadcnValueEditor } from "@/components/query-builder";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import {
  countTrafficConditions,
  customRuleValue,
  getTrafficScopeConflicts,
  setTrafficGroupCombinator,
} from "./model";
import type { TrafficScopeBuilderProps, TrafficScopeFieldDefinition } from "./types";

type TrafficField = Field & { definition: TrafficScopeFieldDefinition };

export function TrafficScopeBuilder({
  definitions,
  query,
  onQueryChange,
  maxRules = 16,
  className,
}: TrafficScopeBuilderProps) {
  const { t } = useTranslation();
  const fields = useMemo(() => createFields(definitions, t), [definitions, t]);
  const ruleCount = countTrafficConditions(query);
  const conflicts = getTrafficScopeConflicts(query, definitions);

  return (
    <section className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <div className="border-b bg-muted/35 p-4">
        <div>
          <div className="flex items-center gap-2">
            <ListFilter className="size-4 text-primary" />
            <h3 className="text-base font-semibold">{t("routers.trafficScopeBuilder.title")}</h3>
          </div>
          <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground">{t("routers.trafficScopeBuilder.description")}</p>
        </div>
      </div>

      <div className="grid gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t("routers.trafficScopeBuilder.expressionDescription")}</p>
            <span className="rounded-md border bg-background px-2 py-1 font-mono text-xs text-muted-foreground">{ruleCount} / {maxRules}</span>
          </div>

          <QueryBuilderShadcn>
            <QueryBuilder
              fields={fields}
              query={query}
              onQueryChange={onQueryChange}
              combinators={[
                { name: "and", label: t("routers.trafficScopeBuilder.allConditions") },
                { name: "or", label: t("routers.trafficScopeBuilder.anyCondition") },
              ]}
              controlElements={{
                actionElement: TrafficActionElement,
                valueEditor: TrafficValueEditor,
              }}
              controlClassnames={{
                queryBuilder: "traffic-scope-query-builder queryBuilder-branches",
                ruleGroup: "rounded-lg border p-3",
                header: "flex flex-wrap items-center gap-2",
                combinators: "min-h-10 w-48 bg-card",
                addRule: "min-h-10",
                addGroup: "min-h-10",
                removeGroup: "min-h-10",
                body: "mt-2 space-y-1",
                rule: "grid gap-2 py-1 sm:grid-cols-[minmax(170px,1.05fr)_minmax(125px,.65fr)_minmax(240px,1.35fr)_40px] sm:items-start",
                fields: "min-h-10 bg-card",
                operators: "min-h-10 bg-card",
                value: "min-h-10 bg-card",
                removeRule: "min-h-10 min-w-10",
              }}
              translations={{
                addRule: { label: <><Plus />{t("routers.trafficScopeBuilder.add")}</>, title: t("routers.trafficScopeBuilder.add") },
                addGroup: { label: <><Plus />{t("routers.trafficScopeBuilder.addGroup")}</>, title: t("routers.trafficScopeBuilder.addGroup") },
                removeRule: { label: <Trash2 />, title: t("routers.trafficScopeBuilder.remove") },
                removeGroup: { label: <Trash2 />, title: t("routers.trafficScopeBuilder.removeGroup") },
                combinators: { title: t("routers.trafficScopeBuilder.ruleRelation") },
                fields: { title: t("routers.trafficScopeBuilder.field") },
                operators: { title: t("routers.trafficScopeBuilder.operator") },
                value: { title: t("routers.trafficScopeBuilder.value") },
              }}
              addRuleToNewGroups
              maxLevels={3}
              onAddRule={(rule) => {
                if (ruleCount >= maxRules) {
                  toast.error(t("routers.trafficScopeBuilder.ruleLimit", { count: maxRules }));
                  return false;
                }
                return rule;
              }}
              resetOnFieldChange
            />
          </QueryBuilderShadcn>

          {conflicts.map((conflict) => {
            const label = t(`routers.trafficScopeFields.${conflict.field.replaceAll(".", "_")}`);
            const field = conflict.key ? `${label}:${conflict.key}` : label;
            return (
              <Alert key={`${conflict.path.join(".")}:${conflict.field}:${conflict.key}`} className="border-amber-200 bg-amber-50 text-amber-800">
                <AlertTriangle />
                <AlertTitle>{t("routers.trafficScopeBuilder.conflictTitle")}</AlertTitle>
                <AlertDescription className="text-amber-800/80">
                  <p>{t("routers.trafficScopeBuilder.exclusiveEqualsConflict", { field, values: conflict.values.join(" / ") })}</p>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="mt-1 h-auto p-0 text-amber-800"
                    onClick={() => onQueryChange(setTrafficGroupCombinator(query, conflict.path, "or"))}
                  >
                    {t("routers.trafficScopeBuilder.changeGroupToOr")}
                  </Button>
                </AlertDescription>
              </Alert>
            );
          })}
      </div>
    </section>
  );
}

function TrafficActionElement({
  className,
  handleOnClick,
  label,
  title,
  disabled,
  disabledTranslation,
  testID,
  rules: _rules,
  ruleOrGroup: _ruleOrGroup,
  path: _path,
  level: _level,
  context: _context,
  validation: _validation,
  schema: _schema,
  ...otherProps
}: ActionProps) {
  const removing = testID === "remove-rule" || testID === "remove-group";
  const addingGroup = testID === "add-group";
  return (
    <Button
      {...otherProps}
      data-testid={testID}
      type="button"
      variant={removing ? "ghost" : addingGroup ? "outline" : "default"}
      size={removing ? "icon" : "default"}
      className={className}
      title={disabledTranslation && disabled ? disabledTranslation.title : title}
      disabled={disabled && !disabledTranslation}
      onClick={(event) => handleOnClick(event)}
    >
      {disabledTranslation && disabled ? disabledTranslation.label : label}
    </Button>
  );
}

function TrafficValueEditor(props: ValueEditorProps) {
  const definition = (props.fieldData as TrafficField).definition;
  if (!definition?.custom_key) {
    return <ShadcnValueEditor {...props} className={cn(props.className, "min-h-10")} extraProps={{ "aria-label": fieldLabelForId(props.field) }} />;
  }
  const encoded = customRuleValue(props.value);
  return (
    <div className={cn(props.className, "grid min-w-0 gap-2 sm:grid-cols-2")}>
      <Input
        className="min-h-10 font-mono text-xs"
        aria-label="Attribute name"
        value={encoded.key}
        placeholder={definition.source === "header" ? "x-app-id" : definition.source === "jwt_claim" ? "department" : "sdk.agent_id"}
        disabled={props.disabled}
        onChange={(event) => props.handleOnChange({ ...encoded, key: event.target.value })}
      />
      <Input
        className="min-h-10 font-mono text-xs"
        aria-label="Attribute value"
        value={encoded.value}
        placeholder="finance-agent"
        disabled={props.disabled}
        onChange={(event) => props.handleOnChange({ ...encoded, value: event.target.value })}
      />
    </div>
  );
}

function createFields(
  definitions: TrafficScopeFieldDefinition[],
  t: (key: string) => string,
) {
  const groupOrder = ["request", "authentication", "http", "model", "litellm", "a2a"];
  return groupOrder.flatMap((group) => {
    const options = definitions.filter((item) => item.group === group).map((definition) => ({
      name: definition.id,
      label: t(`routers.trafficScopeFields.${definition.id.replaceAll(".", "_")}`),
      definition,
      operators: definition.operators.map((operator) => ({ name: operator, label: t(`routers.trafficScopeOperators.${operator}`) })),
      valueEditorType: definition.values.length ? "select" as const : "text" as const,
      values: definition.values.map((value) => ({ name: value, label: value })),
      defaultValue: definition.custom_key ? { key: "", value: "" } : definition.values[0] ?? "",
      placeholder: valuePlaceholder(definition.id),
    } satisfies TrafficField));
    return options.length ? [{ label: t(`routers.trafficScopeGroups.${group}`), options }] : [];
  });
}

function fieldLabelForId(field: unknown) {
  return typeof field === "string" ? field : "Traffic scope value";
}

function valuePlaceholder(id: string) {
  if (id === "http.host") return "api.internal.example";
  if (id === "http.path") return "/v1/finance/";
  if (id === "a2a.extensions") return "https://example.com/extensions/payments/v1";
  if (id === "a2a.operation") return "SendMessage";
  if (id === "model") return "qwen3-*";
  return "finance-agent";
}
