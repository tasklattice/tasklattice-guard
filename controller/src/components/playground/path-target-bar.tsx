import { useTranslation } from "react-i18next";
import { NativeSelect as CarbonNativeSelect } from "@/components/ui/native-select";
import { Cable, GitBranch, LoaderCircle, Route, ScanLine, Send, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { PathTestSelect } from "./path-test-controls";
import type { PathWorkbench } from "./use-path-workbench";

export function PathTargetBar({ workbench: w }: { workbench: PathWorkbench }) {
  const { t: uiText } = useTranslation();
  const { t } = useTranslation();
  return (
    <div className="path-target-bar">
      <div className="path-target-fields">
        <Field icon={<Target />} label={t("routing.testTarget")}>
          <PathTestSelect
            label="Test path"
            value={w.target}
            disabled={w.pending}
            onChange={(v) => w.setTarget(v as "router" | "endpoint")}
            options={[
              { value: "router", label: "Router" },
              { value: "endpoint", label: "Endpoint" },
            ]}
          />
        </Field>
        <Field icon={w.target === "router" ? <Route /> : <Cable />} label={w.target === "router" ? "Router" : "Endpoint"}>
          <PathTestSelect
            label={w.target === "router" ? "Router" : "Endpoint"}
            value={
              (w.target === "router" ? w.router?.id : w.endpoint?.id) ?? ""
            }
            disabled={w.pending}
            onChange={w.target === "router" ? w.setRouterId : w.setEndpointId}
            options={(w.target === "router" ? w.routers : w.endpoints).map(
              (item) => ({ value: item.id, label: item.name }),
            )}
          />
        </Field>
        {w.target === "router" ? (
          <>
            <Field icon={<GitBranch />} label={t("routing.configuration")}>
              <PathTestSelect
                label="Configuration"
                value={w.configuration}
                disabled={w.pending}
                onChange={(v) =>
                  w.changeConfiguration(v as "published" | "draft")
                }
                options={[
                  {
                    value: "published",
                    label: w.router?.activeRevision ? `${t("routing.published")} · r${w.router.activeRevision}` : t("routing.notPublished"),
                  },
                  {
                    value: "draft",
                    label: `${t("routing.draft")} · r${w.router?.draftRevision ?? "—"}`,
                  },
                ]}
              />
            </Field>
            <Field icon={<Cable />} label={t("routing.sourceEndpoint")}>
              <PathTestSelect
                label="Source Endpoint"
                value={w.endpoint?.id ?? ""}
                disabled={w.pending}
                onChange={w.setEndpointId}
                options={w.availableEndpoints.map((e) => ({
                  value: e.id,
                  label: e.name,
                }))}
              />
            </Field>
            <Field icon={<ScanLine />} label={t("routing.testScope")}>
              <PathTestSelect
                label="Test scope"
                value={w.action}
                disabled={w.pending}
                onChange={(v) => w.setAction(v as "simulate" | "execute")}
                options={[
                  { value: "simulate", label: t("routing.routingOnly") },
                  ...(w.configuration === "published"
                    ? [
                        {
                          value: "execute",
                          label: t("routing.routeAndExecute"),
                        },
                      ]
                    : []),
                ]}
              />
            </Field>
          </>
        ) : (
          <p className="path-bound-router">{uiText("uiCopy.router")}{w.boundRouter?.name ?? "—"} · r
            {w.boundRouter?.activeRevision ?? "—"}
          </p>
        )}
      </div>
      <div className="path-request-line">
        <CarbonNativeSelect
          aria-label={uiText("uiCopy.hTTPMethod")}
          className="path-http-method"
          value={w.draft.method}
          disabled={w.pending || w.target === "endpoint"}
          onChange={(e) => w.setDraft({ ...w.draft, method: e.target.value })}
        >
          {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(
            (m) => (
              <option key={m}>{m}</option>
            ),
          )}
        </CarbonNativeSelect>
        <Input
          aria-label={uiText("uiCopy.requestURL")}
          className="path-request-url"
          value={w.draft.url}
          readOnly={w.target === "endpoint"}
          disabled={w.pending}
          onChange={(e) => w.setDraft({ ...w.draft, url: e.target.value })}
        />
        <Button
          variant="testing"
          className="path-send-button"
          disabled={w.pending || Boolean(w.unavailable)}
          onClick={() => void w.submit()}
        >
          {w.pending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          {w.pending
            ? t("routing.testing")
            : w.target === "router" && w.action === "simulate"
              ? t("routing.testRouting")
              : t("routing.sendTest")}
        </Button>
      </div>
      <p className="path-request-hint">
        {w.unavailable ||
          (w.target === "endpoint"
            ? t("routing.forwardedThroughControllerToTheRunnerEndpointExternalIngress")
            : w.configuration === "draft"
              ? t("routing.draftMatchingPreviewCandidatesOnlyNoGuardRailExecution")
              : w.action === "execute"
                ? t("routing.runnerRoutesTheBusinessRequestAndEvaluatesItsBody")
                : t("routing.businessRequestSampleMatchedByTheRunnerUsingIts"))}
      </p>
    </div>
  );
}
function Field({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="path-target-field">
      <div className="path-field-label"><span aria-hidden="true">{icon}</span>{label}</div>
      {children}
    </div>
  );
}
