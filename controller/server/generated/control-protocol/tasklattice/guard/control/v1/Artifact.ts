// Original file: artifact.proto

import type { GuardrailPlan as _tasklattice_guard_control_v1_GuardrailPlan, GuardrailPlan__Output as _tasklattice_guard_control_v1_GuardrailPlan__Output } from '../../../../tasklattice/guard/control/v1/GuardrailPlan.js';
import type { PromptDefinition as _tasklattice_guard_control_v1_PromptDefinition, PromptDefinition__Output as _tasklattice_guard_control_v1_PromptDefinition__Output } from '../../../../tasklattice/guard/control/v1/PromptDefinition.js';
import type { ActionBinding as _tasklattice_guard_control_v1_ActionBinding, ActionBinding__Output as _tasklattice_guard_control_v1_ActionBinding__Output } from '../../../../tasklattice/guard/control/v1/ActionBinding.js';
import type { ArtifactDependency as _tasklattice_guard_control_v1_ArtifactDependency, ArtifactDependency__Output as _tasklattice_guard_control_v1_ArtifactDependency__Output } from '../../../../tasklattice/guard/control/v1/ArtifactDependency.js';
import type { Long } from '@grpc/proto-loader';

/**
 * Immutable, signed Guardrail runtime package distributed to Runner pools.
 */
export interface Artifact {
  'artifactId'?: (string);
  'guardrailId'?: (string);
  /**
   * Immutable Guardrail version compiled into this artifact.
   */
  'guardrailVersion'?: (number);
  /**
   * Desired-state generation for which Controller accepted and signed the artifact.
   */
  'generation'?: (number | string | Long);
  /**
   * Compiler implementation version that produced the artifact.
   */
  'compilerVersion'?: (string);
  /**
   * NeMo Guardrails version against which the runtime payload was compiled.
   */
  'nemoVersion'?: (string);
  /**
   * Runtime profiles are registry identifiers so third-party runtimes do not
   * require a control protocol enum change.
   */
  'runtimeProfile'?: (string);
  'plan'?: (_tasklattice_guard_control_v1_GuardrailPlan | null);
  /**
   * Opaque compiled NeMo YAML; it is not an alternate business-object contract.
   */
  'configYaml'?: (string);
  /**
   * Opaque compiled Colang source consumed by NeMo.
   */
  'colangContent'?: (string);
  'prompts'?: (_tasklattice_guard_control_v1_PromptDefinition)[];
  'actionBindings'?: (_tasklattice_guard_control_v1_ActionBinding)[];
  'dependencyManifest'?: (_tasklattice_guard_control_v1_ArtifactDependency)[];
  /**
   * Lowercase SHA-256 hex digest of the canonical unsigned artifact payload.
   */
  'checksum'?: (string);
  /**
   * Base64 Ed25519 signature over the UTF-8 checksum, produced by Controller.
   */
  'signature'?: (string);
}

/**
 * Immutable, signed Guardrail runtime package distributed to Runner pools.
 */
export interface Artifact__Output {
  'artifactId': (string);
  'guardrailId': (string);
  /**
   * Immutable Guardrail version compiled into this artifact.
   */
  'guardrailVersion': (number);
  /**
   * Desired-state generation for which Controller accepted and signed the artifact.
   */
  'generation': (string);
  /**
   * Compiler implementation version that produced the artifact.
   */
  'compilerVersion': (string);
  /**
   * NeMo Guardrails version against which the runtime payload was compiled.
   */
  'nemoVersion': (string);
  /**
   * Runtime profiles are registry identifiers so third-party runtimes do not
   * require a control protocol enum change.
   */
  'runtimeProfile': (string);
  'plan': (_tasklattice_guard_control_v1_GuardrailPlan__Output | null);
  /**
   * Opaque compiled NeMo YAML; it is not an alternate business-object contract.
   */
  'configYaml': (string);
  /**
   * Opaque compiled Colang source consumed by NeMo.
   */
  'colangContent': (string);
  'prompts': (_tasklattice_guard_control_v1_PromptDefinition__Output)[];
  'actionBindings': (_tasklattice_guard_control_v1_ActionBinding__Output)[];
  'dependencyManifest': (_tasklattice_guard_control_v1_ArtifactDependency__Output)[];
  /**
   * Lowercase SHA-256 hex digest of the canonical unsigned artifact payload.
   */
  'checksum': (string);
  /**
   * Base64 Ed25519 signature over the UTF-8 checksum, produced by Controller.
   */
  'signature': (string);
}
