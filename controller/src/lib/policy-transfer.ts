import type { ProgrammablePolicy, ProgrammablePolicyDraft } from "@/lib/api";
import { isGuardrailCategoryId } from "../../shared/guardrail-catalog";

export const POLICY_PACKAGE_FORMAT = "tasklattice.policy";
export const POLICY_PACKAGE_SCHEMA_VERSION = 1;

export type PolicyPackageErrorCode = "invalidJson" | "invalidPackage" | "unsupportedSchema" | "missingPolicy" | "missingDraft" | "unsupportedColang" | "invalidDraft" | "missingName" | "missingOwner";

export class PolicyPackageError extends Error {
  constructor(public readonly code: PolicyPackageErrorCode, message: string) {
    super(message);
    this.name = "PolicyPackageError";
  }
}

export type PolicyImport = {
  name: string;
  description: string;
  owner: string;
  draft: ProgrammablePolicyDraft;
  sourcePolicyId: string | null;
  sourceDraftRevision: number | null;
};

type PolicyPackage = {
  format: typeof POLICY_PACKAGE_FORMAT;
  schema_version: typeof POLICY_PACKAGE_SCHEMA_VERSION;
  exported_at: string;
  policy: {
    source_policy_id: string;
    source_draft_revision: number;
    name: string;
    description: string;
    owner: string;
    draft: ProgrammablePolicyDraft;
  };
};

export function serializePolicyPackage(policy: ProgrammablePolicy): string {
  const payload: PolicyPackage = {
    format: POLICY_PACKAGE_FORMAT,
    schema_version: POLICY_PACKAGE_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    policy: {
      source_policy_id: policy.id,
      source_draft_revision: policy.draft_revision,
      name: policy.name,
      description: policy.description,
      owner: policy.owner,
      draft: cloneDraft(policy.draft),
    },
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function parsePolicyPackage(raw: string): PolicyImport {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PolicyPackageError("invalidJson", "The selected file is not valid JSON.");
  }
  const root = objectValue(value, "invalidPackage", "The selected file is not a TaskLattice Policy package.");
  if (root.format !== POLICY_PACKAGE_FORMAT) {
    throw new PolicyPackageError("invalidPackage", "The selected file is not a TaskLattice Policy package.");
  }
  if (root.schema_version !== POLICY_PACKAGE_SCHEMA_VERSION) {
    throw new PolicyPackageError("unsupportedSchema", `Policy package schema ${String(root.schema_version)} is not supported.`);
  }
  const policy = objectValue(root.policy, "missingPolicy", "The Policy package does not contain a policy definition.");
  const draft = objectValue(policy.draft, "missingDraft", "The Policy package does not contain a draft.");
  if (draft.colang_version !== "2.x") {
    throw new PolicyPackageError("unsupportedColang", "Imported custom Policies must use the Colang 2.x programmable runtime.");
  }
  if (typeof draft.guardrail_category !== "string" || !isGuardrailCategoryId(draft.guardrail_category)) {
    throw new PolicyPackageError("invalidDraft", "The Policy package draft has an invalid Guardrail category.");
  }
  for (const field of ["sources", "rail_bindings", "parameter_schema", "action_references", "evaluation_contracts", "prompt_dependencies", "execution_contract", "test_cases"] as const) {
    if (!Array.isArray(draft[field])) {
      throw new PolicyPackageError("invalidDraft", `The Policy package draft field ${field} is invalid.`);
    }
  }
  const name = requiredString(policy.name, "missingName", "The Policy package is missing a name.");
  const owner = requiredString(policy.owner, "missingOwner", "The Policy package is missing an owner.");
  const description = typeof policy.description === "string" ? policy.description : "";
  return {
    name,
    description,
    owner,
    draft: cloneDraft(draft as unknown as ProgrammablePolicyDraft),
    sourcePolicyId: typeof policy.source_policy_id === "string" ? policy.source_policy_id : null,
    sourceDraftRevision: typeof policy.source_draft_revision === "number" ? policy.source_draft_revision : null,
  };
}

export function policyPackageFilename(policy: Pick<ProgrammablePolicy, "id">): string {
  const safeId = policy.id.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "policy";
  return `${safeId}.tasklattice-policy.json`;
}

function cloneDraft(draft: ProgrammablePolicyDraft): ProgrammablePolicyDraft {
  return JSON.parse(JSON.stringify(draft)) as ProgrammablePolicyDraft;
}

function objectValue(value: unknown, code: PolicyPackageErrorCode, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PolicyPackageError(code, message);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, code: PolicyPackageErrorCode, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PolicyPackageError(code, message);
  return value;
}
