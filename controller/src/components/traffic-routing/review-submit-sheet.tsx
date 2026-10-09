import { useTranslation } from "react-i18next";
import { useState, type RefObject } from "react";
import type {
  RouterDraft,
  RouterPublicationPreview,
} from "@/lib/traffic-routing-api";
import { EntitySheet } from "../entity-sheet";
import { ErrorNotice } from "../product-shell";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Field } from "./form";
import { Changes } from "./routing-changes";
export type RoutingReview = RouterPublicationPreview;
export type ChangeSubmission = { reason: string; ticket: string };

/** The pinned Guardrail versions a publication routes to. */
export function RoutedVersions({
  snapshot,
  names,
}: {
  snapshot: RouterDraft;
  names: Array<{ id: string; name: string }>;
}) {
  const { t: localize } = useTranslation();
  return (
    <section className="mt-6 space-y-3">
      <h3 className="font-medium">{localize("routing.guardRailVersions")}</h3>
      {snapshot.routes.map((r) => (
        <div key={r.id} className="rounded-lg border p-3 text-sm">
          <p className="font-medium">{r.name}</p>
          {r.targets.map((t) => (
            <p key={t.id} className="mt-2 break-words text-xs">
              {names.find((g) => g.id === t.guardrailId)?.name ??
                t.guardrailId}{" "}
              ·{" "}
              {t.guardrailVersion}
            </p>
          ))}
        </div>
      ))}
    </section>
  );
}

export function AttachedEndpoints({
  ids,
  endpoints,
}: {
  ids: string[];
  endpoints: Array<{ id: string; name: string }>;
}) {
  const { t: localize } = useTranslation();
  return (
    <section className="mt-6 space-y-2">
      <h3 className="font-medium">{localize("routing.attachedEndpointsAtReview")}</h3>
      {ids.length ? (
        ids.map((id) => (
          <p className="text-sm" key={id}>
            {endpoints.find((e) => e.id === id)?.name ?? id}
          </p>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">{localize("routing.noAttachedEndpoints")}</p>
      )}
    </section>
  );
}

export function ReviewSubmitSheet({
  review,
  before,
  names,
  endpoints,
  pending,
  busy,
  error,
  opener,
  onClose,
  onSubmit,
  onReviewAgain,
}: {
  review: RoutingReview;
  before: RouterDraft | null;
  names: Array<{ id: string; name: string }>;
  endpoints: Array<{ id: string; name: string }>;
  pending: boolean;
  busy: boolean;
  error: Error | null;
  opener: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (submission: ChangeSubmission) => void;
  onReviewAgain: () => void;
}) {
  const { t: localize } = useTranslation();
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState("");
  const submit = () => onSubmit({ reason: reason.trim(), ticket: ticket.trim() });
  return (
    <EntitySheet
      open
      width="xl"
      eyebrow={localize("routing.router")}
      title={localize("routing.reviewRoutingChanges")}
      description={localize("routing.reviewChangesThenSubmitForApproval")}
      closeDisabled={pending}
      returnFocusRef={opener}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      footer={
        <>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onClose()}
          >{localize("routing.cancel")}</Button>
          <Button
            disabled={pending || Boolean(error) || !reason.trim()}
            onClick={submit}
          >
            {pending ? localize("routing.submitting") : localize("routing.submitForApproval")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={localize("routing.changeReason")}>
          <Textarea
            value={reason}
            maxLength={2000}
            rows={3}
            placeholder={localize("routing.changeReasonPlaceholder")}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        <Field label={localize("routing.changeTicketOptional")}>
          <Input
            value={ticket}
            maxLength={128}
            placeholder="CHG-2026-1031"
            onChange={(event) => setTicket(event.target.value)}
          />
        </Field>
        <p className="text-sm text-muted-foreground">{localize("routing.approvalAppliesExactlyThisSnapshot")}</p>
      </div>
      <div className="mt-6">
        <Changes before={before} after={review.snapshot} names={names} />
      </div>
      <RoutedVersions snapshot={review.snapshot} names={names} />
      <AttachedEndpoints ids={review.endpointIds} endpoints={endpoints} />
      {error && (
        <div className="mt-4 space-y-3">
          <ErrorNotice error={error} />
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onReviewAgain()}
          >{localize("routing.reviewAgain")}</Button>
          <Button variant="outline" disabled={busy || !reason.trim()} onClick={submit}>{localize("routing.retrySubmission")}</Button>
        </div>
      )}
    </EntitySheet>
  );
}
