import type { RefObject } from "react";
import type {
  RouterDraft,
  RouterPublicationPreview,
} from "@/lib/traffic-routing-api";
import { EntitySheet } from "../entity-sheet";
import { ErrorNotice } from "../product-shell";
import { Button } from "../ui/button";
import { Changes } from "./routing-changes";
export type RoutingReview = RouterPublicationPreview & {
  key: string;
  sourceDraft: RouterDraft;
};
export function ReviewPublishSheet({
  review,
  before,
  names,
  endpoints,
  pending,
  busy,
  error,
  opener,
  onClose,
  onPublish,
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
  onPublish: () => void;
  onReviewAgain: () => void;
}) {
  return (
    <EntitySheet
      open
      width="xl"
      eyebrow="Router"
      title="Review routing changes"
      description="Review the changes and exact GuardRail versions before creating an immutable revision."
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
          >
            Cancel
          </Button>
          <Button
            disabled={pending || Boolean(error)}
            onClick={() => onPublish()}
          >
            {pending ? "Publishing…" : "Publish revision"}
          </Button>
        </>
      }
    >
      <Changes before={before} after={review.snapshot} names={names} />
      <section className="mt-6 space-y-3">
        <h3 className="font-medium">GuardRail versions</h3>
        {review.snapshot.routes.map((r) => (
          <div key={r.id} className="rounded-lg border p-3 text-sm">
            <p className="font-medium">{r.name}</p>
            {r.targets.map((t) => (
              <p key={t.id} className="mt-2 break-words text-xs">
                {names.find((g) => g.id === t.guardrailId)?.name ??
                  t.guardrailId}{" "}
                ·{" "}
                {review.sourceDraft.routes
                  .find((x) => x.id === r.id)
                  ?.targets.find((x) => x.id === t.id)?.versionStrategy ===
                "latest"
                  ? "Latest → "
                  : ""}
                {t.guardrailVersion}
              </p>
            ))}
          </div>
        ))}
      </section>
      <section className="mt-6 space-y-2">
        <h3 className="font-medium">Attached Endpoints at review</h3>
        {review.endpointIds.length ? (
          review.endpointIds.map((id) => (
            <p className="text-sm" key={id}>
              {endpoints.find((e) => e.id === id)?.name ?? id}
            </p>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No attached Endpoints.
          </p>
        )}
      </section>
      {error && (
        <div className="mt-4 space-y-3">
          <ErrorNotice error={error} />
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onReviewAgain()}
          >
            Review again
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => onPublish()}>
            Retry same publication
          </Button>
        </div>
      )}
    </EntitySheet>
  );
}
