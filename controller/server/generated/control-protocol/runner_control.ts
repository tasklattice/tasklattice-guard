import type * as grpc from '@grpc/grpc-js';
import type { EnumTypeDefinition, MessageTypeDefinition } from '@grpc/proto-loader';

import type { ActionBinding as _tasklattice_guard_control_v1_ActionBinding, ActionBinding__Output as _tasklattice_guard_control_v1_ActionBinding__Output } from './tasklattice/guard/control/v1/ActionBinding.js';
import type { Artifact as _tasklattice_guard_control_v1_Artifact, Artifact__Output as _tasklattice_guard_control_v1_Artifact__Output } from './tasklattice/guard/control/v1/Artifact.js';
import type { ArtifactDependency as _tasklattice_guard_control_v1_ArtifactDependency, ArtifactDependency__Output as _tasklattice_guard_control_v1_ArtifactDependency__Output } from './tasklattice/guard/control/v1/ArtifactDependency.js';
import type { ArtifactResult as _tasklattice_guard_control_v1_ArtifactResult, ArtifactResult__Output as _tasklattice_guard_control_v1_ArtifactResult__Output } from './tasklattice/guard/control/v1/ArtifactResult.js';
import type { AutomatedReasoningFinding as _tasklattice_guard_control_v1_AutomatedReasoningFinding, AutomatedReasoningFinding__Output as _tasklattice_guard_control_v1_AutomatedReasoningFinding__Output } from './tasklattice/guard/control/v1/AutomatedReasoningFinding.js';
import type { AutomatedReasoningPolicy as _tasklattice_guard_control_v1_AutomatedReasoningPolicy, AutomatedReasoningPolicy__Output as _tasklattice_guard_control_v1_AutomatedReasoningPolicy__Output } from './tasklattice/guard/control/v1/AutomatedReasoningPolicy.js';
import type { AutomatedReasoningRuleEvidence as _tasklattice_guard_control_v1_AutomatedReasoningRuleEvidence, AutomatedReasoningRuleEvidence__Output as _tasklattice_guard_control_v1_AutomatedReasoningRuleEvidence__Output } from './tasklattice/guard/control/v1/AutomatedReasoningRuleEvidence.js';
import type { AutomatedReasoningScenario as _tasklattice_guard_control_v1_AutomatedReasoningScenario, AutomatedReasoningScenario__Output as _tasklattice_guard_control_v1_AutomatedReasoningScenario__Output } from './tasklattice/guard/control/v1/AutomatedReasoningScenario.js';
import type { AutomatedReasoningTranslation as _tasklattice_guard_control_v1_AutomatedReasoningTranslation, AutomatedReasoningTranslation__Output as _tasklattice_guard_control_v1_AutomatedReasoningTranslation__Output } from './tasklattice/guard/control/v1/AutomatedReasoningTranslation.js';
import type { CompileRequest as _tasklattice_guard_control_v1_CompileRequest, CompileRequest__Output as _tasklattice_guard_control_v1_CompileRequest__Output } from './tasklattice/guard/control/v1/CompileRequest.js';
import type { CompileResult as _tasklattice_guard_control_v1_CompileResult, CompileResult__Output as _tasklattice_guard_control_v1_CompileResult__Output } from './tasklattice/guard/control/v1/CompileResult.js';
import type { ControllerMessage as _tasklattice_guard_control_v1_ControllerMessage, ControllerMessage__Output as _tasklattice_guard_control_v1_ControllerMessage__Output } from './tasklattice/guard/control/v1/ControllerMessage.js';
import type { DeploymentRoute as _tasklattice_guard_control_v1_DeploymentRoute, DeploymentRoute__Output as _tasklattice_guard_control_v1_DeploymentRoute__Output } from './tasklattice/guard/control/v1/DeploymentRoute.js';
import type { DesiredState as _tasklattice_guard_control_v1_DesiredState, DesiredState__Output as _tasklattice_guard_control_v1_DesiredState__Output } from './tasklattice/guard/control/v1/DesiredState.js';
import type { DrainRequest as _tasklattice_guard_control_v1_DrainRequest, DrainRequest__Output as _tasklattice_guard_control_v1_DrainRequest__Output } from './tasklattice/guard/control/v1/DrainRequest.js';
import type { GroundingClaimEvidence as _tasklattice_guard_control_v1_GroundingClaimEvidence, GroundingClaimEvidence__Output as _tasklattice_guard_control_v1_GroundingClaimEvidence__Output } from './tasklattice/guard/control/v1/GroundingClaimEvidence.js';
import type { GroundingFilterAssessment as _tasklattice_guard_control_v1_GroundingFilterAssessment, GroundingFilterAssessment__Output as _tasklattice_guard_control_v1_GroundingFilterAssessment__Output } from './tasklattice/guard/control/v1/GroundingFilterAssessment.js';
import type { GuardrailPlan as _tasklattice_guard_control_v1_GuardrailPlan, GuardrailPlan__Output as _tasklattice_guard_control_v1_GuardrailPlan__Output } from './tasklattice/guard/control/v1/GuardrailPlan.js';
import type { GuardrailPlanModule as _tasklattice_guard_control_v1_GuardrailPlanModule, GuardrailPlanModule__Output as _tasklattice_guard_control_v1_GuardrailPlanModule__Output } from './tasklattice/guard/control/v1/GuardrailPlanModule.js';
import type { GuardrailPlanStep as _tasklattice_guard_control_v1_GuardrailPlanStep, GuardrailPlanStep__Output as _tasklattice_guard_control_v1_GuardrailPlanStep__Output } from './tasklattice/guard/control/v1/GuardrailPlanStep.js';
import type { GuardrailPolicyBinding as _tasklattice_guard_control_v1_GuardrailPolicyBinding, GuardrailPolicyBinding__Output as _tasklattice_guard_control_v1_GuardrailPolicyBinding__Output } from './tasklattice/guard/control/v1/GuardrailPolicyBinding.js';
import type { IntegrationCredential as _tasklattice_guard_control_v1_IntegrationCredential, IntegrationCredential__Output as _tasklattice_guard_control_v1_IntegrationCredential__Output } from './tasklattice/guard/control/v1/IntegrationCredential.js';
import type { IntegrationRuntime as _tasklattice_guard_control_v1_IntegrationRuntime, IntegrationRuntime__Output as _tasklattice_guard_control_v1_IntegrationRuntime__Output } from './tasklattice/guard/control/v1/IntegrationRuntime.js';
import type { IntegrationVerification as _tasklattice_guard_control_v1_IntegrationVerification, IntegrationVerification__Output as _tasklattice_guard_control_v1_IntegrationVerification__Output } from './tasklattice/guard/control/v1/IntegrationVerification.js';
import type { PolicyActionReference as _tasklattice_guard_control_v1_PolicyActionReference, PolicyActionReference__Output as _tasklattice_guard_control_v1_PolicyActionReference__Output } from './tasklattice/guard/control/v1/PolicyActionReference.js';
import type { PolicyRailBinding as _tasklattice_guard_control_v1_PolicyRailBinding, PolicyRailBinding__Output as _tasklattice_guard_control_v1_PolicyRailBinding__Output } from './tasklattice/guard/control/v1/PolicyRailBinding.js';
import type { PolicySource as _tasklattice_guard_control_v1_PolicySource, PolicySource__Output as _tasklattice_guard_control_v1_PolicySource__Output } from './tasklattice/guard/control/v1/PolicySource.js';
import type { PolicyVersion as _tasklattice_guard_control_v1_PolicyVersion, PolicyVersion__Output as _tasklattice_guard_control_v1_PolicyVersion__Output } from './tasklattice/guard/control/v1/PolicyVersion.js';
import type { PromptDefinition as _tasklattice_guard_control_v1_PromptDefinition, PromptDefinition__Output as _tasklattice_guard_control_v1_PromptDefinition__Output } from './tasklattice/guard/control/v1/PromptDefinition.js';
import type { ProviderEvidence as _tasklattice_guard_control_v1_ProviderEvidence, ProviderEvidence__Output as _tasklattice_guard_control_v1_ProviderEvidence__Output } from './tasklattice/guard/control/v1/ProviderEvidence.js';
import type { RegistrationAccepted as _tasklattice_guard_control_v1_RegistrationAccepted, RegistrationAccepted__Output as _tasklattice_guard_control_v1_RegistrationAccepted__Output } from './tasklattice/guard/control/v1/RegistrationAccepted.js';
import type { RiskFinding as _tasklattice_guard_control_v1_RiskFinding, RiskFinding__Output as _tasklattice_guard_control_v1_RiskFinding__Output } from './tasklattice/guard/control/v1/RiskFinding.js';
import type { RunnerControlClient as _tasklattice_guard_control_v1_RunnerControlClient, RunnerControlDefinition as _tasklattice_guard_control_v1_RunnerControlDefinition } from './tasklattice/guard/control/v1/RunnerControl.js';
import type { RunnerHeartbeat as _tasklattice_guard_control_v1_RunnerHeartbeat, RunnerHeartbeat__Output as _tasklattice_guard_control_v1_RunnerHeartbeat__Output } from './tasklattice/guard/control/v1/RunnerHeartbeat.js';
import type { RunnerLoad as _tasklattice_guard_control_v1_RunnerLoad, RunnerLoad__Output as _tasklattice_guard_control_v1_RunnerLoad__Output } from './tasklattice/guard/control/v1/RunnerLoad.js';
import type { RunnerMessage as _tasklattice_guard_control_v1_RunnerMessage, RunnerMessage__Output as _tasklattice_guard_control_v1_RunnerMessage__Output } from './tasklattice/guard/control/v1/RunnerMessage.js';
import type { RunnerRegistration as _tasklattice_guard_control_v1_RunnerRegistration, RunnerRegistration__Output as _tasklattice_guard_control_v1_RunnerRegistration__Output } from './tasklattice/guard/control/v1/RunnerRegistration.js';
import type { RuntimeTraceStep as _tasklattice_guard_control_v1_RuntimeTraceStep, RuntimeTraceStep__Output as _tasklattice_guard_control_v1_RuntimeTraceStep__Output } from './tasklattice/guard/control/v1/RuntimeTraceStep.js';
import type { StringPair as _tasklattice_guard_control_v1_StringPair, StringPair__Output as _tasklattice_guard_control_v1_StringPair__Output } from './tasklattice/guard/control/v1/StringPair.js';
import type { TrafficCondition as _tasklattice_guard_control_v1_TrafficCondition, TrafficCondition__Output as _tasklattice_guard_control_v1_TrafficCondition__Output } from './tasklattice/guard/control/v1/TrafficCondition.js';
import type { TrafficScope as _tasklattice_guard_control_v1_TrafficScope, TrafficScope__Output as _tasklattice_guard_control_v1_TrafficScope__Output } from './tasklattice/guard/control/v1/TrafficScope.js';
import type { ValidationCaseResult as _tasklattice_guard_control_v1_ValidationCaseResult, ValidationCaseResult__Output as _tasklattice_guard_control_v1_ValidationCaseResult__Output } from './tasklattice/guard/control/v1/ValidationCaseResult.js';
import type { ValidationMetrics as _tasklattice_guard_control_v1_ValidationMetrics, ValidationMetrics__Output as _tasklattice_guard_control_v1_ValidationMetrics__Output } from './tasklattice/guard/control/v1/ValidationMetrics.js';
import type { ValidationRequest as _tasklattice_guard_control_v1_ValidationRequest, ValidationRequest__Output as _tasklattice_guard_control_v1_ValidationRequest__Output } from './tasklattice/guard/control/v1/ValidationRequest.js';
import type { ValidationResult as _tasklattice_guard_control_v1_ValidationResult, ValidationResult__Output as _tasklattice_guard_control_v1_ValidationResult__Output } from './tasklattice/guard/control/v1/ValidationResult.js';
import type { ValidationTestCase as _tasklattice_guard_control_v1_ValidationTestCase, ValidationTestCase__Output as _tasklattice_guard_control_v1_ValidationTestCase__Output } from './tasklattice/guard/control/v1/ValidationTestCase.js';

type SubtypeConstructor<Constructor extends new (...args: any) => any, Subtype> = {
  new(...args: ConstructorParameters<Constructor>): Subtype;
};

export interface ProtoGrpcType {
  tasklattice: {
    guard: {
      control: {
        v1: {
          ActionBinding: MessageTypeDefinition<_tasklattice_guard_control_v1_ActionBinding, _tasklattice_guard_control_v1_ActionBinding__Output>
          Artifact: MessageTypeDefinition<_tasklattice_guard_control_v1_Artifact, _tasklattice_guard_control_v1_Artifact__Output>
          ArtifactDependency: MessageTypeDefinition<_tasklattice_guard_control_v1_ArtifactDependency, _tasklattice_guard_control_v1_ArtifactDependency__Output>
          ArtifactResult: MessageTypeDefinition<_tasklattice_guard_control_v1_ArtifactResult, _tasklattice_guard_control_v1_ArtifactResult__Output>
          AutomatedReasoningFinding: MessageTypeDefinition<_tasklattice_guard_control_v1_AutomatedReasoningFinding, _tasklattice_guard_control_v1_AutomatedReasoningFinding__Output>
          AutomatedReasoningPolicy: MessageTypeDefinition<_tasklattice_guard_control_v1_AutomatedReasoningPolicy, _tasklattice_guard_control_v1_AutomatedReasoningPolicy__Output>
          AutomatedReasoningResult: EnumTypeDefinition
          AutomatedReasoningRuleEvidence: MessageTypeDefinition<_tasklattice_guard_control_v1_AutomatedReasoningRuleEvidence, _tasklattice_guard_control_v1_AutomatedReasoningRuleEvidence__Output>
          AutomatedReasoningScenario: MessageTypeDefinition<_tasklattice_guard_control_v1_AutomatedReasoningScenario, _tasklattice_guard_control_v1_AutomatedReasoningScenario__Output>
          AutomatedReasoningTranslation: MessageTypeDefinition<_tasklattice_guard_control_v1_AutomatedReasoningTranslation, _tasklattice_guard_control_v1_AutomatedReasoningTranslation__Output>
          ClaimSupport: EnumTypeDefinition
          CompileRequest: MessageTypeDefinition<_tasklattice_guard_control_v1_CompileRequest, _tasklattice_guard_control_v1_CompileRequest__Output>
          CompileResult: MessageTypeDefinition<_tasklattice_guard_control_v1_CompileResult, _tasklattice_guard_control_v1_CompileResult__Output>
          ContentView: EnumTypeDefinition
          ControllerMessage: MessageTypeDefinition<_tasklattice_guard_control_v1_ControllerMessage, _tasklattice_guard_control_v1_ControllerMessage__Output>
          DeploymentRoute: MessageTypeDefinition<_tasklattice_guard_control_v1_DeploymentRoute, _tasklattice_guard_control_v1_DeploymentRoute__Output>
          DesiredState: MessageTypeDefinition<_tasklattice_guard_control_v1_DesiredState, _tasklattice_guard_control_v1_DesiredState__Output>
          DrainRequest: MessageTypeDefinition<_tasklattice_guard_control_v1_DrainRequest, _tasklattice_guard_control_v1_DrainRequest__Output>
          EnforcementAction: EnumTypeDefinition
          EscalationMode: EnumTypeDefinition
          EvaluationStage: EnumTypeDefinition
          EvaluatorVerdict: EnumTypeDefinition
          FailureMode: EnumTypeDefinition
          GroundingClaimEvidence: MessageTypeDefinition<_tasklattice_guard_control_v1_GroundingClaimEvidence, _tasklattice_guard_control_v1_GroundingClaimEvidence__Output>
          GroundingFilterAssessment: MessageTypeDefinition<_tasklattice_guard_control_v1_GroundingFilterAssessment, _tasklattice_guard_control_v1_GroundingFilterAssessment__Output>
          GroundingFilterType: EnumTypeDefinition
          GuardrailPhase: EnumTypeDefinition
          GuardrailPlan: MessageTypeDefinition<_tasklattice_guard_control_v1_GuardrailPlan, _tasklattice_guard_control_v1_GuardrailPlan__Output>
          GuardrailPlanModule: MessageTypeDefinition<_tasklattice_guard_control_v1_GuardrailPlanModule, _tasklattice_guard_control_v1_GuardrailPlanModule__Output>
          GuardrailPlanStep: MessageTypeDefinition<_tasklattice_guard_control_v1_GuardrailPlanStep, _tasklattice_guard_control_v1_GuardrailPlanStep__Output>
          GuardrailPolicyBinding: MessageTypeDefinition<_tasklattice_guard_control_v1_GuardrailPolicyBinding, _tasklattice_guard_control_v1_GuardrailPolicyBinding__Output>
          IntegrationCredential: MessageTypeDefinition<_tasklattice_guard_control_v1_IntegrationCredential, _tasklattice_guard_control_v1_IntegrationCredential__Output>
          IntegrationRuntime: MessageTypeDefinition<_tasklattice_guard_control_v1_IntegrationRuntime, _tasklattice_guard_control_v1_IntegrationRuntime__Output>
          IntegrationVerification: MessageTypeDefinition<_tasklattice_guard_control_v1_IntegrationVerification, _tasklattice_guard_control_v1_IntegrationVerification__Output>
          OutputDeliveryMode: EnumTypeDefinition
          PolicyActionReference: MessageTypeDefinition<_tasklattice_guard_control_v1_PolicyActionReference, _tasklattice_guard_control_v1_PolicyActionReference__Output>
          PolicyExecutionMode: EnumTypeDefinition
          PolicyModule: EnumTypeDefinition
          PolicyRailBinding: MessageTypeDefinition<_tasklattice_guard_control_v1_PolicyRailBinding, _tasklattice_guard_control_v1_PolicyRailBinding__Output>
          PolicySource: MessageTypeDefinition<_tasklattice_guard_control_v1_PolicySource, _tasklattice_guard_control_v1_PolicySource__Output>
          PolicyVersion: MessageTypeDefinition<_tasklattice_guard_control_v1_PolicyVersion, _tasklattice_guard_control_v1_PolicyVersion__Output>
          PromptDefinition: MessageTypeDefinition<_tasklattice_guard_control_v1_PromptDefinition, _tasklattice_guard_control_v1_PromptDefinition__Output>
          ProviderEvidence: MessageTypeDefinition<_tasklattice_guard_control_v1_ProviderEvidence, _tasklattice_guard_control_v1_ProviderEvidence__Output>
          RailType: EnumTypeDefinition
          RegistrationAccepted: MessageTypeDefinition<_tasklattice_guard_control_v1_RegistrationAccepted, _tasklattice_guard_control_v1_RegistrationAccepted__Output>
          RiskFinding: MessageTypeDefinition<_tasklattice_guard_control_v1_RiskFinding, _tasklattice_guard_control_v1_RiskFinding__Output>
          RouteDecision: EnumTypeDefinition
          /**
           * RunnerControl is the only state-distribution channel between the control
           * plane and data plane. Every business payload is a typed imported message;
           * the stream envelope contains no embedded JSON documents.
           */
          RunnerControl: SubtypeConstructor<typeof grpc.Client, _tasklattice_guard_control_v1_RunnerControlClient> & { service: _tasklattice_guard_control_v1_RunnerControlDefinition }
          RunnerHeartbeat: MessageTypeDefinition<_tasklattice_guard_control_v1_RunnerHeartbeat, _tasklattice_guard_control_v1_RunnerHeartbeat__Output>
          RunnerLoad: MessageTypeDefinition<_tasklattice_guard_control_v1_RunnerLoad, _tasklattice_guard_control_v1_RunnerLoad__Output>
          RunnerMessage: MessageTypeDefinition<_tasklattice_guard_control_v1_RunnerMessage, _tasklattice_guard_control_v1_RunnerMessage__Output>
          RunnerRegistration: MessageTypeDefinition<_tasklattice_guard_control_v1_RunnerRegistration, _tasklattice_guard_control_v1_RunnerRegistration__Output>
          RuntimeTraceStep: MessageTypeDefinition<_tasklattice_guard_control_v1_RuntimeTraceStep, _tasklattice_guard_control_v1_RuntimeTraceStep__Output>
          SafetyLevel: EnumTypeDefinition
          StringPair: MessageTypeDefinition<_tasklattice_guard_control_v1_StringPair, _tasklattice_guard_control_v1_StringPair__Output>
          TargetSource: EnumTypeDefinition
          TrafficCombinator: EnumTypeDefinition
          TrafficCondition: MessageTypeDefinition<_tasklattice_guard_control_v1_TrafficCondition, _tasklattice_guard_control_v1_TrafficCondition__Output>
          TrafficOperator: EnumTypeDefinition
          TrafficScope: MessageTypeDefinition<_tasklattice_guard_control_v1_TrafficScope, _tasklattice_guard_control_v1_TrafficScope__Output>
          ValidationCaseResult: MessageTypeDefinition<_tasklattice_guard_control_v1_ValidationCaseResult, _tasklattice_guard_control_v1_ValidationCaseResult__Output>
          ValidationDecision: EnumTypeDefinition
          ValidationFailure: EnumTypeDefinition
          ValidationMetrics: MessageTypeDefinition<_tasklattice_guard_control_v1_ValidationMetrics, _tasklattice_guard_control_v1_ValidationMetrics__Output>
          ValidationRequest: MessageTypeDefinition<_tasklattice_guard_control_v1_ValidationRequest, _tasklattice_guard_control_v1_ValidationRequest__Output>
          ValidationResult: MessageTypeDefinition<_tasklattice_guard_control_v1_ValidationResult, _tasklattice_guard_control_v1_ValidationResult__Output>
          ValidationStage: EnumTypeDefinition
          ValidationStatus: EnumTypeDefinition
          ValidationTestCase: MessageTypeDefinition<_tasklattice_guard_control_v1_ValidationTestCase, _tasklattice_guard_control_v1_ValidationTestCase__Output>
        }
      }
    }
  }
}

