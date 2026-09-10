import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Router, RouterRuntimeTrace } from "@/lib/api";
import { DeleteRouterSheet, RouterRuntimeEventTable } from "./router-detail";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", exists: () => false } }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

const trace: RouterRuntimeTrace = {
  id: "trace-1",
  created_at: "2026-08-14T03:11:02.123Z",
  router_id: "router-1",
  guardrail_id: "guardrail-1",
  guardrail_version: "20260904-010000.001Z",
  endpoint_id: "endpoint-1",
  protocol: "litellm",
  phase: "output",
  outcome: "transform",
  action: "redact",
  risk: null,
  severity: null,
  latency_ms: 15,
  timed_out: false,
  runtime_engine: "llmrails",
  config_checksum: "checksum",
  detail: "A native rail modified the interaction.",
  findings: [],
  steps: [],
};

describe("Router runtime event density", () => {
  afterEach(cleanup);

  it("shows millisecond timestamps in compact rows", () => {
    render(<RouterRuntimeEventTable traces={[trace]} loading={false} error={null} policies={[]} onInspect={() => undefined} />);
    expect(screen.getByText(/\d{2}:\d{2}:\d{2}\.123/)).toBeTruthy();
    expect(screen.getByText("15 ms")).toBeTruthy();
    expect(screen.getByRole("row", { name: /\d{2}:\d{2}:\d{2}\.123/ }).className).toContain("h-11");
  });
});

describe("Router protected delete", () => {
  afterEach(cleanup);

  it("requires a reason and exact-name confirmation for recent traffic", () => {
    const router = {
      id: "router-1",
      name: "Regional traffic",
      guardrail_id: "guardrail-1",
      guardrail_version: "20260904-010000.001Z",
      endpoint_id: "endpoint-1",
      route_order: 0,
      traffic_scope: { combinator: "and", conditions: [] },
      enabled: true,
      is_default: false,
      system_managed: false,
      updated_at: "2026-08-24T08:00:00.000Z",
    } satisfies Router;
    const onConfirm = vi.fn();
    render(<DeleteRouterSheet
      router={router}
      open
      impact={{
        router_id: router.id,
        router_name: router.name,
        window_minutes: 30,
        incoming_request_count: 14,
        last_request_at: "2026-08-24T08:00:00.000Z",
        active_router_count: 1,
        telemetry_fresh: true,
        telemetry_watermark: "2026-08-24T08:00:01.000Z",
        requires_second_confirmation: true,
        requires_confirmation: true,
      }}
      loading={false}
      deleting={false}
      error={null}
      onOpenChange={vi.fn()}
      onRetry={vi.fn()}
      onConfirm={onConfirm}
    />);

    const continueButton = screen.getByRole("button", { name: "routerDetail.continueDelete" }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("routerDetail.deleteReason"), { target: { value: "Traffic moved to a new route" } });
    fireEvent.click(continueButton);
    const confirmButton = screen.getByRole("button", { name: "routerDetail.deleteDespiteTraffic" }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("routerDetail.typeNameToConfirm"), { target: { value: router.name } });
    fireEvent.click(confirmButton);

    expect(onConfirm).toHaveBeenCalledWith({
      reason: "Traffic moved to a new route",
      confirm_recent_traffic: true,
      confirmation_name: router.name,
    });
  });
});
