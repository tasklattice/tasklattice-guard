import { useState } from "react";
import type {
  RouterDraft,
  TrafficRoute,
  SelectorField,
} from "@/lib/traffic-routing-api";
import { EntitySheet } from "../entity-sheet";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field } from "./form";
import { SelectorEditor } from "./selector-editor";
import { TargetsEditor } from "./targets-editor";
import { SelectorPreviewPanel } from "./selector-preview";
import { ruleErrors } from "./route-rule-validation";

export function RouteEditorSheet({
  initialRoute,
  isNew,
  draft,
  routerId,
  endpointIds,
  fields,
  busy,
  onApply,
  onClose,
}: {
  initialRoute: TrafficRoute;
  isNew: boolean;
  draft: RouterDraft;
  routerId: string;
  endpointIds: string[];
  fields?: SelectorField[];
  busy: boolean;
  onApply: (route: TrafficRoute) => void;
  onClose: () => void;
}) {
  const [route, setRoute] = useState(() => structuredClone(initialRoute));
  const [submitted, setSubmitted] = useState(false);
  const fallback = route.kind === "fallback";
  const errors = ruleErrors(route);
  const previewDraft = {
    routes: isNew
      ? [
          ...draft.routes.filter((r) => r.kind !== "fallback"),
          route,
          ...draft.routes.filter((r) => r.kind === "fallback"),
        ]
      : draft.routes.map((r) => (r.id === route.id ? route : r)),
  };
  return (
    <EntitySheet
      open
      width="xl"
      eyebrow="Routing rule"
      title={
        fallback
          ? "Edit fallback"
          : isNew
            ? "Create routing rule"
            : "Edit routing rule"
      }
      description="Select incoming traffic, then choose its GuardRail destinations. Changes apply to the draft until you publish."
      closeDisabled={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={isNew ? "create" : "edit"}
            disabled={busy}
            onClick={() => {
              setSubmitted(true);
              if (!errors.length)
                onApply({ ...route, name: route.name.trim() });
            }}
          >
            {isNew ? "Add rule" : "Apply changes"}
          </Button>
        </>
      }
    >
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        {!fallback && (
          <Field label="Route name">
            <Input
              value={route.name}
              onChange={(e) => setRoute({ ...route, name: e.target.value })}
            />
          </Field>
        )}
        <section className="min-w-0 space-y-4">
          <div>
            <h3 className="font-semibold">
              {fallback ? "Unmatched traffic" : "Traffic Selector"}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {fallback
                ? "All traffic that did not match an earlier rule."
                : "Describe which requests this rule should receive."}
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
            <h3 className="font-semibold">GuardRails</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {fallback
                ? "One GuardRail receives 100% of unmatched traffic."
                : "One target receives all matching traffic. Multiple targets split it by percentage; each request reaches one target."}
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
      {!fallback && (
        <details className="mt-6 border-t pt-3">
          <summary className="min-h-11 cursor-pointer py-3 text-sm">
            Test matching
          </summary>
          <SelectorPreviewPanel
            routerId={routerId}
            endpointIds={endpointIds}
            draft={previewDraft}
          />
        </details>
      )}
    </EntitySheet>
  );
}
