import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadGuardrailArtifact } from "./guardrail-export";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("Guardrail file download", () => {
  it("writes a parseable Artifact file and releases its temporary URL after download starts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const artifact = { guardrailId: "g", guardrailVersion: "20261007-010000.000Z", checksum: "pinned", signature: "signed", plan: { policyVersions: [{ sources: [{ content: "frozen source" }] }] } };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(artifact)));
    vi.stubGlobal("fetch", fetch);
    const create = vi.fn().mockReturnValue("blob:guardrail");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    let filename = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { filename = this.download; expect(document.body.contains(this)).toBe(true); });
    await downloadGuardrailArtifact("g", artifact.guardrailVersion);
    expect(fetch).toHaveBeenCalledWith(`/api/v1/guardrails/g/versions/${artifact.guardrailVersion}/export`, expect.objectContaining({ credentials: "same-origin" }));
    expect(filename).toBe(`g-${artifact.guardrailVersion}.artifact.json`);
    const blob = create.mock.calls[0]![0] as Blob;
    const content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(blob);
    });
    expect(JSON.parse(content)).toEqual(artifact);
    expect(revoke).not.toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).toHaveBeenCalledWith("blob:guardrail");
  });
  it("does not download an API error as a file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "guardrail_version_not_ready", message: "Publish first" } }), { status: 409 })));
    const create = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create });
    await expect(downloadGuardrailArtifact("g", "20261007-010000.000Z")).rejects.toThrow("Publish first");
    expect(create).not.toHaveBeenCalled();
  });
});
