// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { ControllerConfig } from "../config.js";
import type { ControllerDatabase } from "../db/client.js";
import type { EnvironmentCheck } from "../domain/environment-check.js";
import { GuardrailPackageService } from "./guardrail-packages.js";

it("keeps environment work active until all sibling checks settle after a database failure", async () => {
  const query = { from: vi.fn().mockReturnThis(), innerJoin: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: "a", version: "1" }, { id: "b", version: "1" }]) };
  const service = new GuardrailPackageService({ select: () => query } as unknown as ControllerDatabase, {} as ControllerConfig, () => []);
  service.setArtifactAdmission(vi.fn());
  const firstError = new Error("database failure"), held = Promise.withResolvers<EnvironmentCheck>();
  const check = vi.spyOn(service, "checkVersionEnvironment").mockRejectedValueOnce(firstError).mockReturnValueOnce(held.promise);
  let completed = false;
  const work = service.checkPendingEnvironments().then(() => { completed = true; }, error => { completed = true; return error; });
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
  expect(completed).toBe(false);
  await service.checkPendingEnvironments(); expect(query.limit).toHaveBeenCalledOnce();
  held.reject(new Error("sibling failure")); expect(await work).toBe(firstError);
  query.limit.mockResolvedValueOnce([]);
  await service.checkPendingEnvironments(); expect(query.limit).toHaveBeenCalledTimes(2);
});
