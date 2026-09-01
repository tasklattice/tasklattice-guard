import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComplianceDocumentAnalysis, Policy } from "@/lib/api";

import { ComplianceDocumentImport } from "./compliance-document-import";

const analyzeMock = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, analyzeComplianceDocuments: (...args: unknown[]) => analyzeMock(...args) };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        "common.requestFailed": "Request failed",
        "common.unknownError": "Unknown error",
        "guardrailWizard.documentImportTitle": "Import compliance documents",
        "guardrailWizard.documentImportDescription": "Extract a review draft.",
        "guardrailWizard.documentChoose": "Choose documents",
        "guardrailWizard.documentAdd": "Add document",
        "guardrailWizard.documentEmpty": "No compliance documents selected",
        "guardrailWizard.documentFormats": "Up to {{count}} files",
        "guardrailWizard.documentSelectedFiles": "Selected compliance documents",
        "guardrailWizard.documentRemove": "Remove {{name}}",
        "guardrailWizard.documentUnsupported": "{{name}} is not supported.",
        "guardrailWizard.documentTooLarge": "{{name}} is too large.",
        "guardrailWizard.documentTotalTooLarge": "The selected documents exceed the 10 MB combined limit.",
        "guardrailWizard.documentLimit": "Select no more than {{count}} documents.",
        "guardrailWizard.documentSelectedCount": "{{count}} documents selected",
        "guardrailWizard.documentPrivacy": "Extracted text is sent to {{analyst}}; original files are not stored.",
        "guardrailWizard.documentAnalyze": "Analyze {{count}} documents",
        "guardrailWizard.documentAnalyzing": "Analyzing {{count}} documents…",
        "guardrailWizard.documentDraftReady": "Compliance draft ready for review",
        "guardrailWizard.documentDraftSummary": "{{requirements}} requirements · {{policies}} Policies",
        "guardrailWizard.documentDraft": "Draft",
        "guardrailWizard.documentApplied": "Applied",
        "guardrailWizard.documentPurpose": "Proposed business purpose",
        "guardrailWizard.documentRecommendedPolicies": "Recommended existing Policies",
        "guardrailWizard.documentRequirements": "Extracted requirements ({{count}})",
        "guardrailWizard.documentReviewNotes": "Confirm before applying",
        "guardrailWizard.documentApplyDescription": "Apply this review draft.",
        "guardrailWizard.documentApply": "Apply proposal",
        "guardrailWizard.documentEffects.block": "Block",
      };
      return Object.entries(values ?? {}).reduce((label, [name, value]) => label.replace(`{{${name}}}`, String(value)), labels[key] ?? key);
    },
    i18n: { language: "en" },
  }),
}));

const analysis: ComplianceDocumentAnalysis = {
  summary: "Support customer service while protecting account data.",
  allowed_topics: ["Customer support"],
  restricted_topics: ["Credential disclosure"],
  recommended_policy_ids: ["baseline-pii-protection"],
  review_notes: ["Confirm the complete identifier scope."],
  requirements: [{
    title: "Protect credentials",
    description: "Do not disclose account credentials.",
    effect: "block",
    source_refs: ["document-1:lines-1-2"],
  }],
  sources: [{
    id: "document-1",
    name: "customer-policy.txt",
    format: "txt",
    size_bytes: 64,
    sha256: "a".repeat(64),
    character_count: 64,
    section_count: 1,
  }],
};

const policy = {
  id: "baseline-pii-protection",
  name: "Baseline PII Protection",
} as Policy;

function renderImport(onApply = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return {
    onApply,
    ...render(
      <QueryClientProvider client={client}>
        <ComplianceDocumentImport
          available
          analystProvider="DeepSeek"
          analystModel="deepseek-chat"
          language="en"
          policies={[policy]}
          resetKey={1}
          onApply={onApply}
        />
      </QueryClientProvider>,
    ),
  };
}

describe("Compliance document import", () => {
  beforeEach(() => analyzeMock.mockReset());
  afterEach(cleanup);

  it("queues multiple supported files, analyzes them together, and explicitly applies the proposal", async () => {
    analyzeMock.mockResolvedValue(analysis);
    const { onApply } = renderImport();
    const file = new File(["Customer data policy content"], "customer-policy.txt", { type: "text/plain" });
    const supplement = new File(["Additional retention requirements"], "retention-policy.txt", { type: "text/plain" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');

    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [file, supplement] } });
    expect(screen.getByText("customer-policy.txt")).toBeTruthy();
    expect(screen.getByText("retention-policy.txt")).toBeTruthy();
    expect(screen.getByText("2 documents selected")).toBeTruthy();
    expect(screen.getByText(/DeepSeek · deepseek-chat/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Analyze 2 documents" }));

    await waitFor(() => expect(analyzeMock).toHaveBeenCalledWith([file, supplement], "en"));

    await waitFor(() => expect(screen.getByText("Compliance draft ready for review")).toBeTruthy());
    expect(screen.getByText("Protect credentials")).toBeTruthy();
    expect(screen.getByText("Baseline PII Protection")).toBeTruthy();
    expect(screen.getByText("document-1:lines-1-2")).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply proposal" }));
    expect(onApply).toHaveBeenCalledWith(analysis);
    expect(screen.getAllByText("Applied").length).toBeGreaterThan(0);
  });

  it("rejects unsupported files and enforces the three-document client limit", () => {
    renderImport();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');

    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [new File(["pdf"], "policy.pdf")] } });
    expect(screen.getByRole("alert").textContent).toContain("policy.pdf is not supported");

    fireEvent.change(input!, {
      target: {
        files: Array.from({ length: 4 }, (_, index) => new File(["content"], `policy-${index}.txt`, { lastModified: index + 1 })),
      },
    });
    expect(screen.getByRole("alert").textContent).toContain("no more than 3");
    expect(screen.queryByText("policy-0.txt")).toBeNull();
  });
});
