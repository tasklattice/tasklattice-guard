import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { ValidationEvidenceSheet } from "./validation-evidence-sheet";
import { downloadLogFile } from "@/lib/http-log-content";
import type { ModelValidationReport } from "@/lib/controller-api";

vi.mock("@/lib/http-log-content", async original => ({ ...await original<typeof import("@/lib/http-log-content")>(), downloadLogFile: vi.fn() }));
beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const output = (state: string) => ({
  validation_context: { runner_id: "runner-local", recorded_at: "2026-11-05T00:00:00Z", model: "auto", runner_build: { version: "0.3.20", commit: "abc" } },
  evaluation_evidence: [{ evidence: JSON.stringify({judgments: { unsafe_content: { probability: 0.8319, answer: "unknown" }, harmful_assistance: { probability: 0.9577, answer: "yes" } }, thresholds: { lower: 0.1, upper: 0.9 } }) }],
  model_exchanges: [{ request: { method:"POST", url:"https://laya.test/v1/systemone", headers: {authorization:"[REDACTED]"}, body:JSON.stringify({state, model:"auto"}) }, response: {status:200, body:JSON.stringify({model:"english", answers:{unsafe_content:{noul:0.8319}}})} }],
});
const check: ModelValidationReport["checks"][number] = {id:"probe:content_safety.input:laya",scope:"capability",status:"passed",message:"Both samples passed",latencyMs:0,cases:[
  {id:"content:input:safe",passed:true,inputContent:"Safe input",expectedDecision:"allow",actualDecision:"allow",reason:"",outputContent:JSON.stringify(output("safe wire input"))},
  {id:"content:input:unsafe",passed:true,inputContent:"Unsafe input",expectedDecision:"block",actualDecision:"block",reason:"",outputContent:JSON.stringify(output("unsafe wire input"))},
]};
const open = (value=check) => { render(<ValidationEvidenceSheet check={value} subject="Content safety / Input / Laya" label="Samples passed" />); fireEvent.click(screen.getByRole("button",{name:/(Pass|Failed) evidence ·/})); };

it("shows evidence for success, switches samples, and exports every sample and captured context", () => {
  open();
  expect(screen.getByText("Safe input")).toBeTruthy();
  expect(screen.getByText("runner-local")).toBeTruthy();
  expect(screen.getByText("0.8319")).toBeTruthy();
  expect(screen.getByText("0.9577")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:/Unsafe sample/}));
  expect(screen.getByText("Unsafe input")).toBeTruthy();
  expect(screen.queryByRole("tab", {name:"Raw evidence"})).toBeNull();
  expect(screen.queryByText("Decision evidence")).toBeNull();
  fireEvent.click(screen.getByRole("tab",{name:/HTTP calls/}));
  expect(screen.getByText(/english/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab",{name:"Payload"}));
  expect(screen.getByText(/unsafe wire input/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Export full evidence"}));
  const [bytes, filename] = vi.mocked(downloadLogFile).mock.calls[0];
  const exported = JSON.parse(new TextDecoder().decode(bytes));
  expect(filename).toBe("validation-probe-content_safety.input-laya.json");
  expect(exported.schema).toBe("tasklattice.validation-evidence.v1");
  expect(exported.check.cases).toHaveLength(2);
  expect(exported.check.cases[0].outputContent).toEqual(output("safe wire input"));
  expect(exported.check.cases[1].outputContent).toEqual(output("unsafe wire input"));
});

it("selects the failing case first and distinguishes a transport error from an HTTP response", () => {
  open({...check,status:"failed", cases:[check.cases![0],{...check.cases![1],passed:false,actualDecision:"block",outputContent:JSON.stringify({model_exchanges:[{request:{url:"https://laya.test",body:"sent"},response:null,error:{type:"ReadTimeout",message:"timed out"}}]})}]});
  expect(screen.getByText("Unsafe input")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab",{name:/HTTP calls/}));
  expect(screen.getByText(/ReadTimeout/)).toBeTruthy();
  expect(screen.getAllByText("No HTTP response captured")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button",{name:/Safe sample/}));
  expect(screen.getByText("Safe input")).toBeTruthy();
});

it("does not invent missing legacy evidence and preserves a raw non-JSON response", () => {
  open({...check, cases:[{...check.cases![0],outputContent:"unstructured old response"}]});
  expect(screen.getByText("unstructured old response")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab",{name:/HTTP calls/}));
  expect(screen.getByText(/Run Validate again/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Export full evidence"}));
  const [bytes] = vi.mocked(downloadLogFile).mock.calls[0];
  expect(JSON.parse(new TextDecoder().decode(bytes)).check.cases[0].outputContent).toBe("unstructured old response");
});

it("shows a preflight failure without implying that model requests were sent", () => {
  open({...check,status:"failed",message:"Runner unavailable",cases:[]});
  expect(screen.getByText("Runner unavailable")).toBeTruthy();
  expect(screen.getByText(/No sample evidence was recorded/)).toBeTruthy();
  expect(screen.queryByRole("tab",{name:/HTTP calls/})).toBeNull();
});

it("keeps retries selectable, copies the selected body, and preserves repeated legacy headers", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const calls = [
    { request: {method:"POST",url:"https://model.test",headers:[["x-test","first"],["x-test","second"]],bodyBase64:btoa('{"retry":false}')}, response: {status:422,bodyBase64:btoa("unsupported parameter")} },
    { request: {method:"POST",url:"https://model.test",bodyBase64:btoa('{"retry":true}')}, response: {status:200,bodyBase64:btoa('{"ok":true}')} },
  ];
  open({...check,cases:[{...check.cases![0],outputContent:JSON.stringify({model_http_evidence:calls})}]});
  fireEvent.click(screen.getByRole("tab",{name:/HTTP calls/}));
  expect(screen.getByRole("region", {name:"Response"}).textContent).toContain('"ok"');
  fireEvent.click(screen.getByRole("button",{name:/Call 1/}));
  expect(screen.getByRole("region", {name:"Response"}).textContent).toBe("unsupported parameter");
  fireEvent.click(screen.getByRole("button",{name:"Copy Response"}));
  expect(writeText).toHaveBeenCalledWith("unsupported parameter");
  fireEvent.click(screen.getByRole("tab",{name:"Headers"}));
  expect(screen.getAllByText("x-test")).toHaveLength(2);
  expect(screen.getByText("first")).toBeTruthy();
  expect(screen.getByText("second")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Export full evidence"}));
  const [bytes] = vi.mocked(downloadLogFile).mock.calls[0];
  expect(JSON.parse(new TextDecoder().decode(bytes)).check.cases[0].outputContent.model_http_evidence).toEqual(calls);
});

it.each([
  {name:"review",data:{evaluation_evidence:[{verdict:"matched",evidence:JSON.stringify({answers:{harmful_assistance:"yes"},review_revision:"review-r2"})}]}, visible:["Review answers","harmful_assistance","yes","review-r2"]},
  {name:"native safety",data:{evaluation_evidence:[{evidence:JSON.stringify({native_verdict:"unsafe",native_categories:["Violence"]})}]},visible:["Native classification","unsafe","Violence"]},
  {name:"jailbreak",data:{evaluation_evidence:[{evidence:JSON.stringify({native_verdict:"safe",jailbreak:false,score:-0.91})}]},visible:["Detector score (−1 to 1)","-0.91","false"]},
  {name:"topic",data:{validation_context:{parameters:{allowed_topics:"Password reset",topic_mode:"strict"}},evaluation_evidence:[{evidence:JSON.stringify({topic_verdict:"on-topic"})}]},visible:["Password reset","strict","on-topic"]},
  {name:"native topic",data:{validation_context:{binding_id:"topic_control.input"},detector_evidence:[{capability:"topic_control",verdict:"not_matched"}]},visible:["Topic classification","on-topic"]},
  {name:"PII",data:{validation_context:{profile:"tali.openai-compatible-pii.v1"},evaluation_evidence:[{evidence:JSON.stringify({native_verdict:"unsafe"})}]},visible:["PII classification","pii"]},
  {name:"grounding",data:{validation_context:{input_context:[{role:"query",text:"Warranty?"},{role:"grounding_source",text:"One year."}]},findings:[{grounding:[{type:"grounding",score:0.42,threshold:0.7,detected:true}],claims:[{claim:"Ten years",support:"unsupported",confidence:0.96,source_block_ids:["warranty"]}]}]},visible:["Warranty?","One year.","0.42","0.7","Ten years","unsupported"]},
  {name:"reasoning",data:{formal_policy:{policy_id:"warranty-policy",policy_version:"v3",confidence_threshold:0.8},findings:[{reasoning:[{result:"invalid",confidence:0.95,contradicting_rules:[{id:"r1",expression:"duration = 1"}],claims_false_scenario:{variable_values:[["duration","10"]]}}]}]},visible:["warranty-policy","v3","invalid","duration = 1","Scenario where claims are false"]},
])("summarizes $name using protocol fields without inventing probabilities", ({data,visible}) => {
  open({...check,cases:[{...check.cases![0],outputContent:JSON.stringify(data)}]});
  for (const value of visible) expect(screen.getByText(value)).toBeTruthy();
  expect(screen.queryByText("Probability")).toBeNull();
  expect(screen.queryByText("Decision evidence")).toBeNull();
});

it("never presents a fallback block as a confirmed topic classification", () => {
  open({...check,status:"failed",cases:[{...check.cases![1],passed:false,reason:"Blocked by fallback",outputContent:JSON.stringify({validation_context:{binding_id:"topic_control.input"},detector_evidence:[{capability:"topic_control",verdict:"error"}],model_exchanges:[]})}]});
  expect(screen.getByText("error")).toBeTruthy();
  expect(screen.queryByText("off-topic")).toBeNull();
  fireEvent.click(screen.getByRole("tab",{name:/HTTP calls/}));
  expect(screen.getByText("No model HTTP requests were captured for this sample.")).toBeTruthy();
});

it("separates a gray-area sample from a wrong judgement and names the cause", () => {
  const gray = {
    failure_class: "threshold",
    evaluation_evidence: [{ verdict: "unknown", evidence: JSON.stringify({ judgments: { unsafe_content: { probability: 0.84, answer: "unknown" } }, thresholds: { lower: 0.1, upper: 0.9 } }) }],
    model_exchanges: [],
  };
  open({...check, status: "failed", cases: [check.cases![0], {...check.cases![1], passed: false, actualDecision: "block", reason: "", outputContent: JSON.stringify(gray)}]});
  // Check badge and sample badge both report an unconfirmed judgement, not a wrong one.
  expect(screen.getAllByText("Inconclusive (gray area)")).toHaveLength(2);
  expect(screen.getByText("Threshold — the score fell inside the configured gray area; the operating point did not confirm a judgement.")).toBeTruthy();
  expect(screen.getByText("0.84")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name:/Safe sample/}));
  expect(screen.queryByText("Failure attribution")).toBeNull();
});

it("surfaces the evaluator error type and calls a protocol mismatch an execution error", () => {
  open({...check, status: "failed", cases: [{...check.cases![1], passed: false, actualDecision: "error", outputContent: JSON.stringify({
    failure_class: "protocol",
    evaluation_evidence: [{ verdict: "error", error_type: "ModelResponseError", evidence: JSON.stringify({}) }],
    model_exchanges: [],
  })}]});
  expect(screen.getByText("ModelResponseError")).toBeTruthy();
  expect(screen.getByText("Protocol — the response did not follow the agreed schema or labels; adapter or deployment mismatch, not detection quality.")).toBeTruthy();
  // A broken protocol response is an execution error, not a wrong model judgement.
  expect(screen.getByText("Execution error")).toBeTruthy();
  expect(screen.queryByText("Failed")).toBeNull();
});
