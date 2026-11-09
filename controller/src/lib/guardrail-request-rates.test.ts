import { afterEach, expect, it, vi } from "vitest";
import { assembleMetrics } from "../../server/services/runtime-metric-results";
import { getGuardrailRequestRates } from "./observability-api";
const now = Date.parse("2026-10-19T02:00:00Z");
function metrics() {
  return assembleMetrics({ window: "1h" }, now, 60_000, "1m", [
    { kind: "guardrail", key: "first", total: 7 },
    { kind: "guardrail", key: "second", total: 3 },
    { kind: "guardrail-trend", key: JSON.stringify(["first", now - 60_000]), total: 7 },
    { kind: "guardrail-trend", key: JSON.stringify(["second", now - 60_000]), total: 3 },
  ], [], [], [{ id: "first", name: "Same name" }, { id: "second", name: "Same name" }], [], []);
}
afterEach(() => vi.unstubAllGlobals());
it("fetches one hour once and assigns same-named Guardrails by stable ID", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(metrics()));
  vi.stubGlobal("fetch", fetch);
  const data = await getGuardrailRequestRates();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/api/v1/telemetry/metrics?window=1h");
  expect(data.byGuardrail.first.at(-2)?.total).toBe(7);
  expect(data.byGuardrail.second.at(-2)?.total).toBe(3);
  expect(data.zeroPoints).toHaveLength(61);
  expect(data.zeroPoints.every(point => point.total === 0)).toBe(true);
});
it.each(["missing-id", "duplicate-id", "missing-groups", "wrong-window", "misaligned", "negative"])("rejects %s instead of presenting zero traffic", async invalid => {
  const data = metrics();
  if (invalid === "missing-id") delete (data.trend_series.guardrail[0] as { guardrailId?: string }).guardrailId;
  if (invalid === "duplicate-id") data.trend_series.guardrail[1].guardrailId = "first";
  if (invalid === "missing-groups") delete (data.trend_series as { guardrail?: unknown }).guardrail;
  if (invalid === "wrong-window") data.window = "24h";
  if (invalid === "misaligned") data.trend_series.guardrail[0].points[0].timestamp = "2026-10-19T00:00:00Z";
  if (invalid === "negative") data.trend_series.guardrail[0].points[0].total = -1;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
  await expect(getGuardrailRequestRates()).rejects.toThrow("unavailable or incomplete");
});
