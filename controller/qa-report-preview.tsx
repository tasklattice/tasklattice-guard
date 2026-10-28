import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "./src/components/ui/tooltip";
import { ValidationDetailSheet } from "./src/routes/validation";
import type { TestCaseResult, ValidationRun, Guardrail } from "./src/lib/api";
import i18n from "./src/i18n";
import "./src/styles.css";
import "./src/design-system.scss";
import "./src/carbon-components.scss";
const result: TestCaseResult = {
  case_id: "validation-case-1",
  name: "Competitor comparison",
  policy_id: "competitor-mention-detection",
  expected_decision: "block",
  actual_decision: "block",
  passed: false,
  evaluator_ids: ["local-rules"],
  evaluation_contracts: ["tali.guard.content-filter.rules.v1"],
  escalated: false,
  model_invocations: 0,
  latency_ms: 7,
  reason: "Matched the pinned Rule contract.",
  phase: "input",
  input_content: "Is Qatar Airways better than Emirates?",
  action: "block",
  output_content: "",
  findings: [],
  trace: [],
  trusted_instruction: "",
  target_source: "user_input",
  query: "",
  grounding_sources: [],
  expected_reasoning_result: null,
  actual_reasoning_result: null,
  case_type: "scenario",
  required: true,
  expected_failure: null,
  actual_failure: null,
  concurrency_group: null,
  source_policy_id: "competitor-comparison-input-filter",
  source_policy_version: "1.95.0",
  source_case_id: "competitor-comparison-002",
  covered_rule_ids: ["competitor-comparison-intent"],
  matched_rule_ids: ["competitor-comparison-intent"],
  superseded_by: [],
  evidence_status: "observed", evidence_detail: "Observed target Rule",
  verified_rule_ids: [], rule_contract_satisfied: true,
};

const trace = [
  {id:"runtime", kind:"runtime", name:"Guardrail checks", status:"completed", detail:"The credential Rule blocked the content.", duration_ms:8922},
  {id:"provider", parent_id:"runtime", kind:"action", name:"Model safety check", status:"error", detail:"Provider returned an unavailable response.", duration_ms:8900},
];
const failed = {...result, case_id:"failure", name:"Credential exfiltration", expected_decision:"block", actual_decision:"allow", covered_rule_ids:["credential/command-password"], matched_rule_ids:[], rule_contract_satisfied:false, actual_failure:"provider_failure", reason:"Expected block; received allow. Expected Policy/Rule evidence was not observed. Provider returned an unavailable response.", trace};
const previewParams = new URLSearchParams(location.search);
const providerError = "All eligible Safety Providers failed: pii_semantic.input:9ec3a7b2-9532-4739-8c2d-db7c887697d5:0: HTTPStatusError";
const providerFailureCase = {
  ...failed, name: "benign-zh", policy_id: "local-payment-data", expected_decision: "allow", actual_decision: "block", latency_ms: 4685,
  source_policy_id: "local-payment-data", source_policy_version: "4.2.0", source_case_id: "benign-zh/input",
  covered_rule_ids: ["financial-pii/credit_card", "financial-pii/iban"], reason: `${providerError}; Expected allow; received block.`,
  trace: [
    { id: "runtime", kind: "runtime", name: "Guardrail input checks", status: "block", detail: "Blocked because the safety check could not complete.", duration_ms: 4685 },
    { id: "provider", parent_id: "runtime", kind: "action", name: "PII semantic input check", status: "error", detail: providerError, duration_ms: 4680 },
  ],
};
const warning = {...result, case_id:"warning", name:"powershell", policy_id:"local-credentials", source_policy_id:"local-credentials", source_policy_version:"4.2.0", source_case_id:"formats-4.2/powershell/output", phase:"output" as const, passed:true, case_type:"rule_acceptance", actual_failure:"provider_failure", covered_rule_ids:["credential/command-password"], matched_rule_ids:["credential/command-password"], rule_contract_satisfied:true, latency_ms:8922, reason:"A built-in content-filter Policy blocked the interaction. Other checks reported provider_failure.", trace};
const run = {id:"testing-report-dedupeqa", guardrail_id:"preview", guardrail_version:"20261028-084851.884Z", source_draft_version:1, subject:"version", candidate_digest:null, test_suite_digest:null, status:"failed", execution_status:"failed", details_loaded:true, metrics:{total:2,passed:1,compliance_rate:50,false_positive_rate:0,false_negative_rate:0,escalation_rate:0,p95_latency_ms:8922}, results:[previewParams.has("trace-error") ? providerFailureCase : failed,warning], excluded_case_ids:[], created_at:"2026-10-28T08:48:51Z"} satisfies ValidationRun;
function Preview(){const [open,setOpen]=React.useState(true); return <><div className="p-8"><h1>Desktop preview · synthetic test cases</h1><button onClick={()=>setOpen(true)}>Open report</button></div>{open && <ValidationDetailSheet run={run} guardrail={{id:"preview",name:"Full-feature baseline · Report layout preview"} as Guardrail} canManage={false} running={false} onRunAgain={()=>{}} onClose={()=>setOpen(false)} />}</>}
i18n.changeLanguage(previewParams.get("lang") === "zh" ? "zh-CN" : "en").then(()=>createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><TooltipProvider><Preview /></TooltipProvider></QueryClientProvider>));
