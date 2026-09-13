import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  listTrafficRouters,
  trafficRouterKeys,
} from "@/lib/traffic-routing-api";
import { getEndpoints } from "@/lib/endpoints-api";
import { requestController } from "@/lib/controller-api";
import { useRoutingText } from "@/components/traffic-routing/form";
import {
  pathTestSchema,
  redactHttpRequest,
  type PathTestInput,
  type PathTestResult,
} from "../../../shared/playground-path";
import {
  endpointRequest,
  importRequest,
  routerRequest,
  serializeRequest,
  type RequestDraft,
} from "./path-request-model";

export type PathTestRecord = {
  id: string;
  createdAt: string;
  label: string;
  configuration: string;
  input: Omit<PathTestInput, "credential">;
  result?: PathTestResult;
  error?: string;
};
export function usePathWorkbench(active: boolean) {
  const t = useRoutingText();
  const initial = new URLSearchParams(window.location.search);
  const [target, setTarget] = useState<"router" | "endpoint">(
    initial.has("endpoint") ? "endpoint" : "router",
  );
  const [routerId, setRouterId] = useState(initial.get("router") ?? "");
  const [endpointId, setEndpointId] = useState(initial.get("endpoint") ?? "");
  const [configuration, setConfiguration] = useState<"published" | "draft">(
    "published",
  );
  const [action, setAction] = useState<"simulate" | "execute">("simulate");
  const [routerDraft, setRouterDraft] = useState(routerRequest);
  const [endpointDrafts, setEndpointDrafts] = useState<
    Record<string, RequestDraft>
  >({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [callId, setCallId] = useState(() => `test-${crypto.randomUUID()}`);
  const [fields, setFields] = useState("{}");
  const [endpointContext, setEndpointContext] = useState("{}");
  const [records, setRecords] = useState<PathTestRecord[]>([]);
  const [current, setCurrent] = useState<PathTestRecord>();
  const [error, setError] = useState<Error | null>(null);
  const routersQuery = useQuery({
    queryKey: trafficRouterKeys.all,
    queryFn: listTrafficRouters,
    enabled: active,
  });
  const endpointsQuery = useQuery({
    queryKey: ["playground-path-endpoints"],
    queryFn: getEndpoints,
    enabled: active,
  });
  const routers = routersQuery.data?.items ?? [];
  const endpoints = endpointsQuery.data?.items ?? [];
  const router = routers.find((r) => r.id === routerId) ?? routers[0];
  const availableEndpoints =
    target === "router"
      ? endpoints.filter((e) => router?.endpointIds.includes(e.id))
      : endpoints;
  const endpoint =
    availableEndpoints.find((e) => e.id === endpointId) ??
    availableEndpoints[0];
  const boundRouter = routers.find((r) =>
    r.endpointIds.includes(endpoint?.id ?? ""),
  );
  const endpointKey = endpoint?.id ?? "";
  // Keep an independent editable document per Endpoint, without synchronizing derived selections through effects.
  const template = useMemo(
    () => endpointRequest(endpointKey, endpoint?.protocol ?? "http"),
    [endpointKey, endpoint?.protocol],
  );
  const draft =
    target === "router"
      ? routerDraft
      : (endpointDrafts[endpointKey] ?? template);
  const setDraft = (value: RequestDraft) =>
    target === "router"
      ? setRouterDraft(value)
      : setEndpointDrafts((previous) => ({
          ...previous,
          [endpointKey]: value,
        }));
  const credential = credentials[endpointKey] ?? "";
  const setCredential = (value: string) =>
    setCredentials((previous) => ({ ...previous, [endpointKey]: value }));
  const mutation = useMutation({
    mutationFn: (input: PathTestInput) =>
      requestController<PathTestResult>("/api/v1/playground/path-tests", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
  const loading = routersQuery.isLoading || endpointsQuery.isLoading;
  const unavailable = loading
    ? t("正在加载测试目标…", "Loading test targets…")
    : target === "router"
      ? !router
        ? t("请先创建 Router。", "Create a Router to test routing.")
        : configuration === "published" && (!router.activeRevision || !endpoint)
          ? t(
              "已发布测试需要发布版本及绑定的 Endpoint。",
              "Published tests require a published revision and a bound Endpoint.",
            )
          : ""
      : !endpoint
        ? t(
            "请先创建 Endpoint。",
            "Create an Endpoint to test its request path.",
          )
        : "";
  const loadExample = () =>
    setDraft(
      target === "router"
        ? routerRequest()
        : endpointRequest(endpointKey, endpoint?.protocol ?? "http"),
    );
  const importSource = (source: string) => {
    const imported = importRequest(source);
    if (target === "endpoint") {
      const expected = endpointRequest(
        endpointKey,
        endpoint?.protocol ?? "http",
      ).url;
      if (imported.method !== "POST" || imported.url !== expected)
        throw new Error(
          t(
            "导入请求必须使用所选 Endpoint 的 POST 路径。",
            "Use the selected Endpoint's POST path.",
          ),
        );
      const apiKey = imported.headers.find(
        (h) => h.name.toLowerCase() === "x-api-key",
      );
      setCredential(apiKey?.value ?? "");
      imported.headers = imported.headers.filter(
        (h) => h.name.toLowerCase() !== "x-api-key",
      );
    }
    setDraft(imported);
  };
  const restore = (item: PathTestRecord) => {
    const input = item.input;
    setTarget(input.target);
    setConfiguration(input.configuration);
    setAction(input.action);
    setRouterId(input.target === "router" ? input.targetId : "");
    setEndpointId(input.endpointId || input.targetId);
    const restored = importRequest(input.request);
    if (input.target === "router") setRouterDraft(restored);
    else {
      setEndpointDrafts((previous) => ({
        ...previous,
        [input.targetId]: restored,
      }));
      setCredentials((previous) => ({ ...previous, [input.targetId]: "" }));
    }
    setCallId(input.callId);
    setFields(JSON.stringify(input.fields, null, 2));
    setEndpointContext(JSON.stringify(input.endpointRequest ?? {}, null, 2));
    setCurrent(item);
    setError(null);
  };
  const submit = async () => {
    if (unavailable || mutation.isPending) return;
    setError(null);
    let input: PathTestInput;
    try {
      input = pathTestSchema.parse({
        target,
        targetId: target === "router" ? router!.id : endpointKey,
        endpointId: endpointKey,
        configuration: target === "endpoint" ? "published" : configuration,
        expectedRevision:
          target === "router"
            ? configuration === "draft"
              ? router?.draftRevision
              : router?.activeRevision
            : undefined,
        action: target === "endpoint" ? "execute" : action,
        request: serializeRequest(draft),
        credential,
        callId,
        fields: target === "router" ? JSON.parse(fields) : {},
        endpointRequest: target === "router" ? JSON.parse(endpointContext) : {},
      });
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const { credential: _credential, ...safe } = input;
    const record: PathTestRecord = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      label: target === "router" ? router!.name : endpoint!.name,
      configuration:
        target === "router"
          ? `${configuration === "draft" ? t("草稿", "Draft") : t("已发布", "Published")} r${input.expectedRevision}`
          : "Runner Endpoint",
      input: { ...safe, request: redactHttpRequest(input.request) },
    };
    setCurrent(undefined);
    try {
      record.result = await mutation.mutateAsync(input);
    } catch (e) {
      record.error = e instanceof Error ? e.message : String(e);
    }
    setCurrent(record);
    setRecords((previous) => [record, ...previous].slice(0, 50));
  };
  return {
    target,
    setTarget,
    router,
    routers,
    setRouterId,
    endpoint,
    endpoints,
    availableEndpoints,
    setEndpointId,
    boundRouter,
    configuration,
    changeConfiguration: (value: "published" | "draft") => {
      setConfiguration(value);
      if (value === "draft") setAction("simulate");
    },
    action,
    setAction,
    draft,
    setDraft,
    credential,
    setCredential,
    callId,
    setCallId,
    fields,
    setFields,
    endpointContext,
    setEndpointContext,
    records,
    current,
    restore,
    clearHistory: () => setRecords([]),
    error: error ?? routersQuery.error ?? endpointsQuery.error,
    unavailable,
    pending: mutation.isPending,
    submit,
    loadExample,
    importSource,
  };
}
export type PathWorkbench = ReturnType<typeof usePathWorkbench>;
