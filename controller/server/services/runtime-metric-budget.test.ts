import { afterEach, expect, it, vi } from "vitest";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import { ControlPlaneService } from "./control-plane.js";
import { currentProjectId, runWithProjectContext } from "./project-context.js";
import { queryRuntimeMetrics } from "./runtime-metrics.js";

vi.mock("./runtime-metrics.js", async importOriginal => ({
  ...await importOriginal<typeof import("./runtime-metrics.js")>(), queryRuntimeMetrics: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const makeService = () => new ControlPlaneService({} as ControllerDatabase, {} as ControllerConfig);
const scope = { window: "24h" as const };
const projectRead = (service: ControlPlaneService, projectId: string) =>
  runWithProjectContext({ projectId, role: "user" }, () => service.runtimeMetrics(scope));

it("shares the read budget across projects and platform reads, releasing it after success and failure", async () => {
  const service = makeService();
  const first = Promise.withResolvers<any>(), second = Promise.withResolvers<any>();
  const projects: Array<string | null> = [];
  vi.mocked(queryRuntimeMetrics).mockImplementationOnce(() => { projects.push(currentProjectId()); return first.promise; })
    .mockImplementationOnce(() => { projects.push(currentProjectId()); return second.promise; });
  const a = projectRead(service, "a"), b = service.runtimeMetrics(scope);
  await expect(projectRead(service, "b")).rejects.toMatchObject({ code: "metrics_busy" });
  await expect(service.runtimeEndpointActivity("endpoint")).rejects.toMatchObject({ code: "metrics_busy" });
  expect(queryRuntimeMetrics).toHaveBeenCalledTimes(2);
  expect(projects).toEqual(["a", null]);
  first.resolve({ total_decisions: 1 });
  await a;
  vi.mocked(queryRuntimeMetrics).mockResolvedValueOnce({ total_decisions: 2 } as any);
  expect(await projectRead(service, "b")).toMatchObject({ total_decisions: 2 });
  const rejected = expect(b).rejects.toThrow("SQL failed");
  second.reject(new Error("SQL failed"));
  await rejected;
  vi.mocked(queryRuntimeMetrics).mockResolvedValueOnce({ total_decisions: 3 } as any);
  expect(await service.runtimeMetrics(scope)).toMatchObject({ total_decisions: 3 });
});

it("does not reuse project snapshots or pending reads across permissions checks", async () => {
  const service = makeService();
  vi.mocked(queryRuntimeMetrics).mockResolvedValueOnce({ total_decisions: 1 } as any)
    .mockResolvedValueOnce({ total_decisions: 0 } as any);
  expect(await projectRead(service, "a")).toMatchObject({ total_decisions: 1 });
  expect(await projectRead(service, "a")).toMatchObject({ total_decisions: 0 });
  expect(queryRuntimeMetrics).toHaveBeenCalledTimes(2);
});

it("still coalesces trusted platform reads of the same scope", async () => {
  const service = makeService(), read = Promise.withResolvers<any>();
  vi.mocked(queryRuntimeMetrics).mockReturnValue(read.promise);
  const a = service.runtimeMetrics(scope), b = service.runtimeMetrics(scope);
  expect(queryRuntimeMetrics).toHaveBeenCalledOnce();
  read.resolve({ total_decisions: 1 });
  expect(await a).toEqual(await b);
  expect(await service.runtimeMetrics(scope)).toEqual(await a);
  expect(queryRuntimeMetrics).toHaveBeenCalledOnce();
});

it("keeps overview and diagnostics caches separate", async () => {
  const service = makeService();
  vi.mocked(queryRuntimeMetrics).mockResolvedValueOnce({ total_decisions: 1, view: "overview" } as any)
    .mockResolvedValueOnce({ total_decisions: 2, view: "diagnostics" } as any);
  expect(await service.runtimeMetrics({ ...scope, view: "overview" })).toMatchObject({ view: "overview" });
  expect(await service.runtimeMetrics(scope)).toMatchObject({ view: "diagnostics" });
  expect(queryRuntimeMetrics).toHaveBeenCalledTimes(2);
});
