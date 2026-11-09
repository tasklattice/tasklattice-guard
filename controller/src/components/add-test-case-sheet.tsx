import { useEffect, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/notifications";

import { EntitySheet } from "@/components/entity-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createTestCase, type Guardrail, type TestCase } from "@/lib/api";

export function AddTestCaseSheet({ guardrail, open, onOpenChange, onCreated }: { guardrail: Guardrail; open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void | Promise<void> }) {
  const { t: uiText } = useTranslation();
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [policyId, setPolicyId] = useState(guardrail.policy_bindings[0]?.policy_id ?? "");
  const [phase, setPhase] = useState<"input" | "output">("input");
  const [content, setContent] = useState("");
  const [expected, setExpected] = useState<TestCase["expected_decision"]>("block");
  useEffect(() => {
    if (open) {
      setName("");
      setPolicyId(guardrail.policy_bindings[0]?.policy_id ?? "");
      setPhase("input");
      setContent("");
      setExpected("block");
    }
  }, [guardrail.policy_bindings, open]);
  const mutation = useMutation({
    mutationFn: () => createTestCase(guardrail.id, {
      name,
      policy_id: policyId,
      phase,
      content,
      expected_decision: expected,
      trusted_instruction: "",
      target_source: phase === "input" ? "user_input" : "model_output",
      query: "",
      grounding_sources: [],
      expected_reasoning_result: null,
    }),
    onSuccess: async () => {
      toast.success(t("guardrails.caseCreated"));
      await onCreated();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : t("guardrails.operationFailed")),
  });
  return <EntitySheet open={open} closeDisabled={mutation.isPending} onOpenChange={next => { if (!mutation.isPending) onOpenChange(next); }} eyebrow={t("guardrails.addCaseEyebrow")} title={t("guardrails.addCaseTitle")} description={t("guardrails.addCaseDescription")} footer={<><Button variant="outline" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button><Button disabled={!name.trim() || !policyId || !content.trim() || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}{t("guardrails.addTestCase")}</Button></>}>
    <div className="grid gap-5">
      <SheetField label={t("guardrails.caseName")}><Input autoFocus className="field:min-h-11" value={name} onChange={(event) => setName(event.target.value)} /></SheetField>
      <SheetField label={t("guardrails.policy")}><Select value={policyId} onValueChange={setPolicyId}><SelectTrigger className="field:min-h-11"><SelectValue /></SelectTrigger><SelectContent>{guardrail.policy_bindings.map((binding) => <SelectItem key={binding.policy_id} value={binding.policy_id}>{binding.policy_id}</SelectItem>)}</SelectContent></Select></SheetField>
      <div className="grid gap-4 sm:grid-cols-2">
        <SheetField label={t("guardrails.modelBoundary")}><Select value={phase} onValueChange={(next) => setPhase(next as typeof phase)}><SelectTrigger className="field:min-h-11"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="input">{uiText("uiCopy.input")}</SelectItem><SelectItem value="output">{uiText("uiCopy.output")}</SelectItem></SelectContent></Select></SheetField>
        <SheetField label={t("guardrails.expectedDecision")}><Select value={expected} onValueChange={(next) => setExpected(next as typeof expected)}><SelectTrigger className="field:min-h-11"><SelectValue /></SelectTrigger><SelectContent>{["allow", "block", "transform", "intervene"].map((decision) => <SelectItem key={decision} value={decision}>{decision}</SelectItem>)}</SelectContent></Select></SheetField>
      </div>
      <SheetField label={t("guardrails.testContent")}><Textarea className="field:min-h-32" value={content} onChange={(event) => setContent(event.target.value)} /></SheetField>
    </div>
  </EntitySheet>;
}

function SheetField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid gap-2"><Label>{label}</Label>{children}</label>;
}
