import { useTranslation } from "react-i18next";
import { StateBadge } from "@/components/product-shell";
import { revisionLabel } from "./router-view-model";
import type { RouterRevision, TrafficRouter } from "@/lib/traffic-routing-api";

export function rolloutLabel(status: string, t: (key: string) => string) {
  return status === "failed" ? t("routing.rolloutFailed") : status === "active" ? t("routing.active") : status === "distributing" ? t("routing.distributing") : t("routing.unpublished");
}

export function RouterRolloutBadge({ router, revision }: { router: TrafficRouter; revision?: RouterRevision }) {
  const { t } = useTranslation();
  const status = rolloutLabel(router.rolloutStatus, t);
  const version = revision?.revision === router.activeRevision ? revisionLabel(revision) : "—";
  const description = version !== "—" ? `${version} · ${status}` : status;
  return <StateBadge
    state={router.rolloutStatus}
    label={router.rolloutStatus === "active" && version !== "—" ? version : description}
    role="img"
    aria-label={description}
    title={description}
  />;
}
