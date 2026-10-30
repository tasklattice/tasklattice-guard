import { modelParameterDeclarationIssues } from "../../shared/policy-parameters.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { policyDefinitionSchema, type PolicyDefinition } from "../../shared/policy-definition.js";
import { policyAssetSchema, type PolicyDto } from "../policy-catalog/catalog.js";
import { policyProtection, protectionContractsSchema } from "../policy-catalog/protection.js";
import { ValidationError } from "../domain/errors.js";

type Adapter = { engine: string; detector: string | null; flow_name: string | null; action_name: string | null; execution: "local" | "platform" };
type Detector = { version: string; adapter: Adapter; profiles?: Record<string, Adapter>; parameters: string[]; required_parameters: string[]; supports_replacement: boolean };

export class DeclarativeCompiler {
  readonly detectors: Record<string, Detector>;
  private readonly contracts;
  constructor(readonly directory: string) {
    this.detectors = JSON.parse(readFileSync(join(directory, "detectors.generated.json"), "utf8")).detectors;
    this.contracts = protectionContractsSchema.parse(JSON.parse(readFileSync(join(directory, "protection-contracts.json"), "utf8")));
  }
  shipped(id: string, version?: string): PolicyDefinition | null {
    const definitions = JSON.parse(readFileSync(join(this.directory, "policy-definitions.generated.json"), "utf8"));
    if (!version || definitions[id]?.metadata.version === version) return definitions[id] ? policyDefinitionSchema.parse(definitions[id]) : null;
    const history = join(this.directory,"policy-history-definitions.generated.json");
    const definition = existsSync(history) ? JSON.parse(readFileSync(history,"utf8"))[`${id}@${version}`] : undefined;
    return definition ? policyDefinitionSchema.parse(definition) : null;
  }
  catalogView(policy: PolicyDto): PolicyDto {
    // Frozen release nodes omit derived Library metadata, including protection.
    // Restore it from that version's own rules before projecting imported history.
    const protection = policy.protection ?? policyProtection(policy, this.contracts);
    const definition = policy.source === "built_in" && protection.execution === "custom" ? this.shipped(policy.id,policy.version) : null;
    const compiled = definition ? this.compile(definition) : null;
    return { ...policy, protection, ...(compiled ? {rules:compiled.rules,definition:compiled.definition!,protection:compiled.protection} : {}),
      ...(policy.published_versions ? {published_versions:policy.published_versions.map(version=>this.catalogView(version))} : {}) };
  }
  fromSnapshot(snapshot: Record<string, unknown>): PolicyDefinition {
    if (snapshot.definition) return policyDefinitionSchema.parse(snapshot.definition);
    const asset = policyAssetSchema.parse({ ...snapshot, source: snapshot.source ?? "custom" });
    return policyDefinitionSchema.parse({ schema_version: 1, kind: "Policy", metadata: {
      id: asset.id, name: asset.name, description: asset.description, version: asset.version, tags: asset.tags,
      safety_level: asset.safety_level, output_delivery: asset.output_delivery,
    }, parameters: asset.parameters, rules: asset.rules.map(rule => {
      const descriptor = this.detectors[rule.detector.ref];
      const parameters = Object.fromEntries((descriptor?.parameters ?? []).flatMap(key => {
        const value = key === "profile" ? rule.detector_options.profile : (rule as Record<string, unknown>)[key];
        return value == null ? [] : [[key, value]];
      }));
      return { id: rule.id, name: rule.name, description: rule.description, stages: rule.rails, detector: { ...rule.detector, parameters },
        on_match: { action: rule.effect, replacement: rule.redaction }, risk_level: rule.risk_severity ?? "medium", metadata: { taxonomy_ids: rule.taxonomy_ids }, expand: rule.rule_expansion };
    }), tests: asset.test_cases.map(test => ({ ...test, scope: test.kind === "rule_acceptance" && test.covered_rule_ids.length === 1 ? "rule" : "policy" })) });
  }
  compile(definition: PolicyDefinition): PolicyDto {
    const issues = modelParameterDeclarationIssues(definition);
    if (issues.length) throw new ValidationError(issues.join("\n"));
    const rules = definition.rules.map(rule => {
      const detector = this.detectors[rule.detector.ref];
      if (!detector || detector.version !== rule.detector.version) throw new ValidationError(`Detector ${rule.detector.ref}@${rule.detector.version} is unavailable.`);
      const params = rule.detector.parameters;
      const runtimeParameters = rule.detector.ref === "model/classifier" && params.profile === "topic-classification" ? ["topic_mode", "allowed_topics", "restricted_topics", "on_unknown", "review_unknown"]
        : rule.detector.ref === "model/classifier" && ["jailbreak-classification", "safety-classification"].includes(String(params.profile)) ? ["on_unknown", "review_unknown"]
        : rule.detector.ref === "model/grounding" ? ["grounding_threshold", "relevance_threshold"] : rule.detector.ref === "service/formal-verification" ? ["policy_snapshot_id", "policy_id", "policy_version", "confidence_threshold"] : [];
      for (const key of Object.keys(params)) if (![...detector.parameters, ...runtimeParameters].includes(key)) throw new ValidationError(`Unsupported ${rule.detector.ref} parameter ${key}.`);
      for (const key of detector.required_parameters) if (params[key] == null) throw new ValidationError(`Detector ${rule.detector.ref} requires ${key}.`);
      const adapter = params.profile === undefined ? detector.adapter : detector.profiles?.[String(params.profile)];
      if (!adapter) throw new ValidationError(`Unknown detector profile ${String(params.profile)}.`);
      if (rule.on_match.action === "transform" && !detector.supports_replacement && adapter.execution === "local") throw new ValidationError(`Detector ${rule.detector.ref} cannot replace text.`);
      const { profile: _profile, ...values } = params;
      return { id: rule.id, name: rule.name || rule.id, description: rule.description, rails: rule.stages,
        detector: { ref: rule.detector.ref, version: rule.detector.version }, effect: rule.on_match.action, risk_severity: rule.risk_level,
        implementation: { ...adapter, binding_id: definition.metadata.id, implementation_rule_id: rule.id },
        ...values, ...(params.profile ? { detector_options: { profile: params.profile } } : {}), redaction: rule.on_match.replacement ?? null, rule_expansion: rule.expand ?? null, taxonomy_ids: rule.metadata.taxonomy_ids };
    });
    // Legacy executable catalog fields are confined to this adapter. The authoring contract has no origin or engine identity.
    const asset = policyAssetSchema.parse({ ...definition.metadata, source: "custom", rules, parameters: definition.parameters, test_cases: definition.tests });
    const rails = [...new Set(asset.rules.flatMap(r => r.rails))];
    const protection = policyProtection({ ...asset, id: "", rails }, this.contracts);
    const modelCapabilities = [...new Set(definition.rules.flatMap(rule => {
      if (rule.detector.ref === "model/classifier") return [{ "safety-classification": "content_safety", "jailbreak-classification": "jailbreak", "pii-classification": "pii_semantic", "topic-classification": "topic_control" }[String(rule.detector.parameters.profile)]!];
      return rule.detector.ref === "model/grounding" ? ["contextual_grounding"] : rule.detector.ref === "service/formal-verification" ? ["automated_reasoning"] : [];
    }))];
    protection.execution = modelCapabilities.length ? "model" : "local";
    protection.modelCapabilities = modelCapabilities;
    protection.requiredContext = [...(modelCapabilities.includes("contextual_grounding") ? ["query", "grounding_source"] : []), ...(modelCapabilities.includes("automated_reasoning") ? ["reasoning_policy"] : [])];
    const { compliance: _compliance, ...compiled } = asset;
    return { ...compiled, implementation: "rules", definition, tags: asset.tags.map(t => ({ ...t, id: `${t.namespace}:${t.value}` })),
      rails, effects: [...new Set(rules.map(r => r.effect))], detectors: [...new Set(rules.map(r => r.detector.ref))],
      test_count: definition.tests.length, protection };
  }
}
