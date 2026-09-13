import { LoaderCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRoutingText } from "@/components/traffic-routing/form";
import { PathTestSelect } from "./path-test-controls";
import type { PathWorkbench } from "./use-path-workbench";

export function PathTargetBar({ workbench: w }: { workbench: PathWorkbench }) {
  const t = useRoutingText();
  return (
    <div className="shrink-0 space-y-3 border-b p-3 sm:p-4">
      <div className="grid grid-cols-2 gap-3 lg:flex lg:flex-wrap lg:items-end">
        <Field label={t("测试目标", "Test target")}>
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
        <Field label={w.target === "router" ? "Router" : "Endpoint"}>
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
            <Field label={t("版本", "Configuration")}>
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
                    label: `${t("已发布", "Published")} · r${w.router?.activeRevision ?? "—"}`,
                  },
                  {
                    value: "draft",
                    label: `${t("草稿", "Draft")} · r${w.router?.draftRevision ?? "—"}`,
                  },
                ]}
              />
            </Field>
            <Field label={t("来源 Endpoint", "Source Endpoint")}>
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
            <Field label={t("测试范围", "Test scope")}>
              <PathTestSelect
                label="Test scope"
                value={w.action}
                disabled={w.pending}
                onChange={(v) => w.setAction(v as "simulate" | "execute")}
                options={[
                  { value: "simulate", label: t("仅检查路由", "Routing only") },
                  ...(w.configuration === "published"
                    ? [
                        {
                          value: "execute",
                          label: t("路由并执行", "Route and execute"),
                        },
                      ]
                    : []),
                ]}
              />
            </Field>
          </>
        ) : (
          <p className="col-span-2 pb-3 text-xs text-muted-foreground">
            Router: {w.boundRouter?.name ?? "—"} · r
            {w.boundRouter?.activeRevision ?? "—"}
          </p>
        )}
      </div>
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 sm:grid-cols-[6rem_minmax(0,1fr)_auto]">
        <select
          aria-label="HTTP method"
          className="h-11 rounded-md border bg-background px-2 font-mono text-sm focus-visible:outline-ring"
          value={w.draft.method}
          disabled={w.pending || w.target === "endpoint"}
          onChange={(e) => w.setDraft({ ...w.draft, method: e.target.value })}
        >
          {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(
            (m) => (
              <option key={m}>{m}</option>
            ),
          )}
        </select>
        <Input
          aria-label="Request URL"
          className="h-11 min-w-0 font-mono text-sm"
          value={w.draft.url}
          readOnly={w.target === "endpoint"}
          disabled={w.pending}
          onChange={(e) => w.setDraft({ ...w.draft, url: e.target.value })}
        />
        <Button
          className="col-span-2 min-h-11 sm:col-span-1"
          disabled={w.pending || Boolean(w.unavailable)}
          onClick={() => void w.submit()}
        >
          {w.pending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          {w.pending
            ? t("测试中…", "Testing…")
            : w.target === "router" && w.action === "simulate"
              ? t("测试路由", "Test routing")
              : t("发送测试", "Send test")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {w.unavailable ||
          (w.target === "endpoint"
            ? t(
                "请求经 Controller 转发到 Runner Endpoint；不覆盖外部 Ingress / TLS。",
                "Forwarded through Controller to the Runner Endpoint; external Ingress / TLS is not tested.",
              )
            : w.configuration === "draft"
              ? t(
                  "草稿匹配预览：显示候选目标，不执行 GuardRail。",
                  "Draft matching preview: candidates only, no GuardRail execution.",
                )
              : w.action === "execute"
                ? t(
                    "Runner 匹配业务请求，并将 Body 作为输入文本检测；不验证 Endpoint 认证。",
                    "Runner routes the business request and evaluates its body as input text; Endpoint authentication is not tested.",
                  )
                : t(
                    "业务请求样本：由 Runner 使用已加载的 Router 配置进行匹配。",
                    "Business request sample: matched by the Runner using its loaded Router configuration.",
                  ))}
      </p>
    </div>
  );
}
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
