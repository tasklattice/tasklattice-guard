import { loadSync } from "@grpc/proto-loader";
import { loadPackageDefinition } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";

import type { Artifact__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/Artifact.js";
import type { GuardrailPlan__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/GuardrailPlan.js";
import type { ProtoGrpcType } from "../generated/control-protocol/runner_control.js";
import {
  artifactFromWire,
  artifactToWire,
  integrationVerificationToWire,
  planFromWire,
  planToWire,
  trafficScopeToWire,
} from "./protocol-codec.js";


const plan = {
  guardrail_id: "guardrail-1",
  guardrail_version: 3,
  compiler_version: "tasklattice-controller-plan-v3",
  safety_level: "strict",
  output_delivery: "full_buffered",
  steps: [{
    id: "pii:semantic", capability: "pii", contract_ref: "tali.guard.pii.semantic.v1",
    phases: ["input", "output"], on_unsafe: "redact",
    trigger: { type: "on_result", step_ref: "pii:exact", verdicts: ["uncertain"] },
    parameters: [["entity_types", "passport,phone"]],
  }],
  modules: [{
    id: "data_protection:input", module: "data_protection", phase: "input",
    step_ids: ["pii:semantic"], depends_on: [], input_view: "original",
    required_for_release: true, timeout_ms: 750, failure_mode: "fail_closed",
  }],
  reasoning_policies: [{
    id: "reasoning-1", policy_id: "passport-policy", policy_version: "1.0.0", confidence_threshold: 0.9,
  }],
  policy_versions: [{
    policy_id: "passport-policy", version: "1.0.0", name: "Passport protection", source: "controller",
    colang_version: "2.x", sources: [{ path: "rails/passport.co", content: "define flow passport" }],
    parameter_schema: [["entity_types", "string"]],
    rail_bindings: [{
      rail_type: "input", flow_name: "passport input", execution_mode: "mutate", on_unsafe: "redact",
      parallel_group: "data-protection", priority: 10, timeout_ms: 500, failure_mode: "fail_closed",
      required: true, depends_on: [],
    }],
    action_references: [{ name: "detect_passport", version: "1.0.0" }],
    evaluation_contracts: ["tali.guard.pii.semantic.v1"], prompt_dependencies: ["passport-prompt"],
    execution_contract: [["native_risk", "pii"]], test_cases: [["safe", "allow"]], checksum: "policy-checksum",
  }],
  policy_bindings: [{
    policy_id: "passport-policy", policy_version: "1.0.0", action: "redact",
    parameter_values: [["entity_types", "passport"]], enabled_rule_ids: ["pii/passport"],
    rule_actions: [["pii/passport", "redact"]], enabled_rails: ["input", "output"],
  }],
};


describe("Controller/Runner control protocol", () => {
  it("serializes a typed message through the service loaded from the split Proto graph", () => {
    const protoPath = resolve("../proto/tasklattice/guard/control/v1/runner_control.proto");
    const definition = loadSync(protoPath, {
      includeDirs: [dirname(protoPath)], longs: String, enums: String, defaults: true, oneofs: true,
    });
    const descriptor = loadPackageDefinition(definition) as unknown as ProtoGrpcType;
    const connect = descriptor.tasklattice.guard.control.v1.RunnerControl.service.Connect;
    const encoded = connect.responseSerialize({
      messageId: "message-1",
      sentAtUnixMs: "1",
      compileRequest: {
        compileId: "compile-1", guardrailId: "guardrail-1", guardrailVersion: 3,
        generation: "11", plan: planToWire(plan), runtimeProfile: "nemo-default",
      },
    });

    const decoded = connect.responseDeserialize(encoded);
    expect(decoded.body).toBe("compileRequest");
    expect(decoded.compileRequest?.plan?.safetyLevel).toBe("SAFETY_LEVEL_STRICT");
    expect(decoded.compileRequest?.plan?.policyBindings[0]?.action).toBe("ENFORCEMENT_ACTION_REDACT");
  });

  it("round-trips the complete Guardrail Plan through generated wire types", () => {
    const wire = planToWire(plan);

    expect(wire.safetyLevel).toBe("SAFETY_LEVEL_STRICT");
    expect(wire.policyBindings?.[0]?.action).toBe("ENFORCEMENT_ACTION_REDACT");
    expect(planFromWire(wire as unknown as GuardrailPlan__Output)).toEqual(plan);
  });

  it("round-trips the canonical signed Artifact body", () => {
    const content = {
      guardrailId: "guardrail-1", guardrailVersion: 3, generation: 11,
      compilerVersion: "compiler-v2", nemoVersion: "0.20.0", runtimeProfile: "nemo-default",
      plan, configYaml: "models: []", colangContent: "define flow passport",
      prompts: [{ task: "passport_check", content: "Check {{ user_input }}", output_parser: "json", max_tokens: 64 }],
      actionBindings: [{
        id: "pii:semantic", capability: "pii", contract_ref: "tali.guard.pii.semantic.v1",
        phases: ["input", "output"], on_unsafe: "redact",
        trigger: { type: "on_result", step_ref: "pii:exact", verdicts: ["uncertain"] }, timeout_ms: 500,
        parameters: [["entity_types", "passport"]], policy_id: "passport-policy", policy_version: "1.0.0",
        flow_name: "passport input", action_name: "detect_passport", action_version: "1.0.0",
        parallel_group: "data-protection", execution_mode: "mutate", failure_mode: "fail_closed",
        depends_on: [], result_var: "passport_result",
      }],
      dependencyManifest: [["evaluation_contract", "tali.guard.pii.semantic.v1", "1"]],
    };
    const wire = artifactToWire({ id: "artifact-1", ...content, checksum: "checksum", signature: "signature" });

    expect(artifactFromWire(wire as unknown as Artifact__Output)).toEqual(content);
  });

  it("uses one typed shape for nested traffic scopes and credential verification", () => {
    expect(trafficScopeToWire({
      combinator: "and",
      conditions: [
        { field: "header", key: "x-tenant", operator: "equals", value: "acme" },
        { combinator: "or", conditions: [{ field: "path", key: "", operator: "starts_with", value: "/agents" }] },
      ],
    })).toEqual({
      combinator: "TRAFFIC_COMBINATOR_AND",
      conditions: [{ field: "header", key: "x-tenant", operator: "TRAFFIC_OPERATOR_EQUALS", value: "acme" }],
      groups: [{
        combinator: "TRAFFIC_COMBINATOR_OR",
        conditions: [{ field: "path", key: "", operator: "TRAFFIC_OPERATOR_STARTS_WITH", value: "/agents" }],
        groups: [],
      }],
    });
    expect(integrationVerificationToWire({ credentials: [{
      id: "credential-1", sha256: "abc", keyHint: "tg_...1234", createdAt: "2026-08-31T00:00:00Z",
    }] })).toEqual({ credentials: [{
      id: "credential-1", sha256: "abc", keyHint: "tg_...1234", createdAt: "2026-08-31T00:00:00Z",
    }] });
  });
});
