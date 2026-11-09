export type GuardrailDraftChange = {
  kind: "setting" | "policyAdded" | "policyRemoved" | "policyOrder" | "policyUpdated" | "caseAdded" | "caseRemoved" | "caseUpdated" | "testScope";
  subject: string;
  field: string;
  before: string;
  after: string;
};

export type GuardrailDraftChanges = {
  draftRevision: number;
  baselineVersion: string | null;
  baselineAvailable: boolean;
  hasUnpublishedChanges: boolean;
  canDiscard: boolean;
  changes: GuardrailDraftChange[];
};
