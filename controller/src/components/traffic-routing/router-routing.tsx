import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowRight,
  ChevronDown,
  GripVertical,
  Plus,
  Trash2,
  Pencil,
  MoreHorizontal,
  ShieldCheck,
} from "lucide-react";
import type {
  RouterDraft,
  TrafficRoute,
  SelectorField,
} from "@/lib/traffic-routing-api";
import { EntitySheet } from "../entity-sheet";
import { RouteEditorSheet } from "./route-editor-sheet";
import { ruleErrors } from "./route-rule-validation";
export { ruleErrors } from "./route-rule-validation";
import { Button } from "../ui/button";
import { percent } from "./form";
import { conditionCount, newRoute, selectorSummary } from "./router-view-model";

type Props = {
  routerId: string;
  endpointIds: string[];
  draft: RouterDraft;
  editableDraft?: RouterDraft;
  editing: boolean;
  canEdit: boolean;
  busy: boolean;
  selected: string | null;
  select: (id: string | null) => void;
  onChange: (draft: RouterDraft) => void;
  onEdit: () => void;
  fields?: SelectorField[];
  guardrails: Array<{ id: string; name: string }>;
};
export function RouterRouting(props: Props) {
  const { draft, editing, busy, onChange } = props;
  const [editor, setEditor] = useState<{
    route: TrafficRoute;
    isNew: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState<TrafficRoute | null>(null);
  const source = editing ? draft : (props.editableDraft ?? draft);
  const configure = (route: TrafficRoute, isNew = false) => {
    props.onEdit();
    setEditor({
      route: isNew
        ? route
        : (source.routes.find((r) => r.id === route.id) ?? route),
      isNew,
    });
  };
  const remove = (route: TrafficRoute) => {
    props.onEdit();
    setDeleting(route);
  };
  const normal = draft.routes.filter((r) => r.kind !== "fallback");
  const fallback = draft.routes.find((r) => r.kind === "fallback");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  return (
    <section className="space-y-5">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div>
          <h2 className="text-lg font-semibold">Routing</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Rules are evaluated from top to bottom. The first matching rule
            determines the GuardRail distribution.
          </p>
        </div>
        {props.canEdit && (
          <Button
            variant="create"
            className="min-h-11"
            disabled={busy || source.routes.length >= 128}
            onClick={() => configure(newRoute(), true)}
          >
            <Plus />
            Add routing rule
          </Button>
        )}
      </div>
      {!normal.length && (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No routing rules configured. Unmatched traffic will use the fallback
          GuardRail.
        </p>
      )}
      <div className="overflow-x-auto">
        <div className="min-w-[36rem] divide-y rounded-lg border">
          <div className="flex items-center bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            {editing && <span className="w-11 shrink-0" />}
            <div className="grid min-w-0 flex-1 grid-cols-[3rem_1fr_1fr_1.5fr] gap-4 px-1">
              <span>#</span>
              <span>Rule</span>
              <span>Match</span>
              <span>Target</span>
            </div>
            {props.canEdit && (
              <span className="ml-3 w-11 shrink-0 text-center">Actions</span>
            )}
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active, over }) => {
              if (!editing || busy || !over || active.id === over.id) return;
              const from = normal.findIndex((r) => r.id === active.id),
                to = normal.findIndex((r) => r.id === over.id);
              if (from >= 0 && to >= 0)
                onChange({
                  routes: [
                    ...arrayMove(normal, from, to),
                    ...(fallback ? [fallback] : []),
                  ],
                });
            }}
          >
            <SortableContext
              items={normal.map((r) => r.id)}
              strategy={verticalListSortingStrategy}
            >
              {normal.map((route, index) => (
                <RuleRow
                  key={route.id}
                  {...props}
                  route={route}
                  index={index}
                  onConfigure={configure}
                  onDelete={remove}
                />
              ))}
            </SortableContext>
          </DndContext>
          {fallback && (
            <RuleRow
              {...props}
              route={fallback}
              index={normal.length}
              onConfigure={configure}
              onDelete={remove}
            />
          )}
        </div>
      </div>
      {editor && editing && (
        <RouteEditorSheet
          key={editor.route.id}
          initialRoute={editor.route}
          isNew={editor.isNew}
          draft={draft}
          routerId={props.routerId}
          endpointIds={props.endpointIds}
          fields={props.fields}
          busy={busy}
          onClose={() => setEditor(null)}
          onApply={(route) => {
            onChange({
              routes: editor.isNew
                ? [...normal, route, ...(fallback ? [fallback] : [])]
                : draft.routes.map((r) => (r.id === route.id ? route : r)),
            });
            props.select(route.id);
            setEditor(null);
          }}
        />
      )}
      {deleting && (
        <EntitySheet
          open
          eyebrow="Routing rule"
          title="Delete routing rule?"
          description={`Remove “${deleting.name}” from the draft. Published traffic is unchanged until you review and publish.`}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          footer={
            <>
              <Button variant="outline" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  onChange({
                    routes: source.routes.filter((r) => r.id !== deleting.id),
                  });
                  props.select(null);
                  setDeleting(null);
                }}
              >
                Delete rule
              </Button>
            </>
          }
        >
          <p className="text-sm">
            Requests that matched this rule will continue to the next matching
            rule or the fallback after publication.
          </p>
        </EntitySheet>
      )}
    </section>
  );
}
function RuleRow(
  props: Props & {
    route: TrafficRoute;
    index: number;
    onConfigure: (route: TrafficRoute, isNew?: boolean) => void;
    onDelete: (route: TrafficRoute) => void;
  },
) {
  const { route, index, editing, busy, selected, select, draft, guardrails } =
    props;
  const fallback = route.kind === "fallback";
  const sortable = useSortable({
    id: route.id,
    disabled: !editing || busy || fallback,
    transition: null,
  });
  const ref = useRef<HTMLDivElement>(null);
  const expanded = selected === route.id;
  useEffect(() => {
    if (expanded) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [expanded]);
  const errors = ruleErrors(route);
  return (
    <article
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform) }}
      className={fallback ? "border-t border-dashed bg-muted/20" : "bg-card"}
    >
      <div ref={ref} className="flex items-center px-3">
        {editing && !fallback && (
          <Button
            variant="ghost"
            className="size-11 touch-none"
            disabled={busy}
            {...sortable.attributes}
            {...sortable.listeners}
            aria-label={`Reorder ${route.name}`}
          >
            <GripVertical />
          </Button>
        )}
        {editing && fallback && <span className="w-11 shrink-0" />}
        <button
          className="grid min-h-16 min-w-0 flex-1 grid-cols-[3rem_1fr_1fr_1.5fr] items-center gap-4 rounded-md px-1 py-4 text-left text-sm outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={
            fallback
              ? "Fallback · All unmatched traffic"
              : `${String(index + 1).padStart(2, "0")} ${route.name}`
          }
          aria-expanded={expanded}
          aria-controls={`rule-${route.id}`}
          onClick={() => select(expanded ? null : route.id)}
        >
          <span className="text-xs text-muted-foreground">
            {fallback ? "↳" : String(index + 1).padStart(2, "0")}
          </span>
          <span className="font-medium">
            {fallback ? "Fallback" : route.name}
            {!route.enabled && (
              <span className="block text-xs text-muted-foreground">
                Disabled
              </span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            {fallback
              ? "All unmatched"
              : `${conditionCount(route.selector.expression)} conditions`}
          </span>
          <span className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              {route.targets.length
                ? route.targets.map((t) => (
                    <span
                      key={t.id}
                      className="flex flex-wrap justify-between gap-x-3 text-xs"
                    >
                      <span>
                        {guardrails.find((g) => g.id === t.guardrailId)?.name ??
                          "GuardRail unavailable"}
                      </span>
                      <span>{percent(t.weightBps)}</span>
                    </span>
                  ))
                : "Choose a GuardRail"}
            </span>
            <ChevronDown
              className={`size-4 shrink-0 ${expanded ? "rotate-180" : ""}`}
            />
          </span>
        </button>
        {props.canEdit && (
          <div className="ml-3 flex w-11 shrink-0 items-center">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="size-11"
                  aria-label={`Actions for ${fallback ? "Fallback" : route.name}`}
                  disabled={
                    busy ||
                    !(props.editableDraft ?? draft).routes.some(
                      (r) => r.id === route.id,
                    )
                  }
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="edit" onSelect={() => props.onConfigure(route)}>
                  <Pencil />
                  Edit
                </DropdownMenuItem>
                {!fallback && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => props.onDelete(route)}
                  >
                    <Trash2 />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {expanded && (
        <div id={`rule-${route.id}`} className="space-y-5 border-t p-4 sm:p-6">
          <div
            className="grid grid-cols-[minmax(0,1fr)_3rem_minmax(0,1fr)] items-center gap-4"
            aria-label="Rule traffic flow"
          >
            <section className="col-start-1 row-start-1 min-w-0 rounded-lg border bg-muted/20 p-4">
              <h3 className="text-xs font-medium text-muted-foreground">
                {fallback ? "Unmatched traffic" : "Traffic Selector"}
              </h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                {fallback
                  ? "Used when no routing rules match."
                  : selectorSummary(route.selector.expression)}
              </p>
            </section>
            {route.targets.map((target, targetIndex) => (
              <Fragment key={target.id}>
                <ArrowRight
                  style={{ gridRow: targetIndex + 1 }}
                  className="col-start-2 mx-auto size-6 text-muted-foreground"
                  aria-hidden="true"
                />
                <div
                  style={{ gridRow: targetIndex + 1 }}
                  className="col-start-3 flex min-w-0 items-start gap-3 rounded-lg border bg-card p-4"
                >
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium">
                      {guardrails.find((g) => g.id === target.guardrailId)
                        ?.name ?? "GuardRail unavailable"}
                    </p>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {target.versionStrategy === "latest"
                        ? "Latest when published"
                        : target.guardrailVersion || "Version not selected"}
                    </p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">
                    {percent(target.weightBps)}
                  </span>
                </div>
              </Fragment>
            ))}
            {!route.targets.length && (
              <>
                <ArrowRight
                  className="col-start-2 mx-auto size-6 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="col-start-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Choose a GuardRail
                </p>
              </>
            )}
          </div>
          {editing && errors.length > 0 && (
            <p className="text-sm text-destructive">{errors[0]}</p>
          )}
        </div>
      )}
    </article>
  );
}
