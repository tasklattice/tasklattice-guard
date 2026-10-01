import { useTranslation } from "react-i18next";
import { useState } from "react";
import type {
  TrafficRoute,
  SelectorField,
} from "@/lib/traffic-routing-api";
import { EntitySheet } from "../entity-sheet";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field } from "./form";
import { SelectorEditor } from "./selector-editor";
import { TargetsEditor } from "./targets-editor";
import { ruleErrors } from "./route-rule-validation";

export function RouteEditorSheet({
  initialRoute,
  isNew,
  fields,
  busy,
  onApply,
  onClose,
}: {
  initialRoute: TrafficRoute;
  isNew: boolean;
  fields?: SelectorField[];
  busy: boolean;
  onApply: (route: TrafficRoute) => void;
  onClose: () => void;
}) {
  const { t: localize } = useTranslation();
  const [route, setRoute] = useState(() => structuredClone(initialRoute));
  const [submitted, setSubmitted] = useState(false);
  const fallback = route.kind === "fallback";
  const errors = ruleErrors(route);
  return (
    <EntitySheet
      open
      width="xl"
      eyebrow={localize("routing.routingRule")}
      title={
        fallback
          ? localize("routing.editFallback")
          : isNew
            ? localize("routing.createRoutingRule")
            : localize("routing.editRoutingRule")
      }
      description={localize("routing.selectIncomingTrafficThenChooseItsGuardRailDestinationsChanges")}
      closeDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{localize("routing.cancel")}</Button>
          <Button
            variant={isNew ? "create" : "edit"}
            disabled={busy}
            onClick={() => {
              setSubmitted(true);
              if (!errors.length)
                onApply({ ...route, name: route.name.trim() });
            }}
          >
            {isNew ? localize("routing.addRule") : localize("routing.applyChanges")}
          </Button>
        </>
      }
    >
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        {!fallback && (
          <Field label={localize("routing.routeName")}>
            <Input
              value={route.name}
              onChange={(e) => setRoute({ ...route, name: e.target.value })}
            />
          </Field>
        )}
        <section className="min-w-0 space-y-4">
          <div>
            <h3 className="font-semibold">
              {fallback ? localize("routing.unmatchedTraffic") : localize("routing.trafficSelector")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {fallback
                ? localize("routing.allTrafficThatDidNotMatchAnEarlierRule")
                : localize("routing.describeWhichRequestsThisRuleShouldReceive")}
            </p>
          </div>
          {!fallback && (
            <>
              <SelectorEditor
                value={route.selector.expression}
                fields={fields}
                onChange={(expression) =>
                  setRoute({ ...route, selector: { expression } })
                }
              />
            </>
          )}
        </section>
        <section className="min-w-0 space-y-4 border-t pt-6">
          <div>
            <h3 className="font-semibold">{localize("routing.guardRails")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {fallback
                ? localize("routing.oneGuardRailReceives100OfUnmatchedTraffic")
                : localize("routing.oneTargetReceivesAllMatchingTrafficMultipleTargetsSplit")}
            </p>
          </div>
          <TargetsEditor
            allowLatest
            fallback={fallback}
            value={route.targets}
            onChange={(targets) => setRoute({ ...route, targets })}
          />
        </section>
        {submitted && errors.length > 0 && (
          <ul
            role="alert"
            className="list-disc space-y-1 pl-5 text-sm text-destructive"
          >
            {errors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        )}
      </fieldset>
    </EntitySheet>
  );
}
