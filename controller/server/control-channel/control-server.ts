import { PROTECTION_MODE_CAPABILITY } from "../../shared/protection-mode.js";
import { isGroupRuntimeConfigurationId, type GroupModelTransaction } from "../model-config/group-runtime.js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import {
  Server,
  ServerCredentials,
  type ServerDuplexStream,
  status,
  loadPackageDefinition,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";

import type { ControllerConfig } from "../config.js";
import type { RunnerLoad } from "../db/schema.js";
import type { ControllerMessage } from "../generated/control-protocol/tasklattice/guard/control/v1/ControllerMessage.js";
import type { CapabilityValidationRequest } from "../generated/control-protocol/tasklattice/guard/control/v1/CapabilityValidationRequest.js";
import type { RailValidationEvidence } from "../model-config/service.js";
import type { RunnerHeartbeat__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/RunnerHeartbeat.js";
import type { RunnerMessage__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/RunnerMessage.js";
import type { RunnerControlHandlers } from "../generated/control-protocol/tasklattice/guard/control/v1/RunnerControl.js";
import type { ValidationResult__Output } from "../generated/control-protocol/tasklattice/guard/control/v1/ValidationResult.js";
import type { ProtoGrpcType } from "../generated/control-protocol/runner_control.js";
import type { ControllerMetrics } from "../metrics.js";
import { capabilityBindingContracts } from "../model-config/domain.js";
import { capabilityBindingDefinitions } from "../../shared/guardrail-catalog.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { ArtifactContent } from "../domain/artifact-content.js";
import { ConflictError } from "../domain/errors.js";
import { tenantOwnerForCreate } from "../services/tenant-context.js";
import type { PoolAdmission, SignedArtifact } from "../domain/environment-check.js";
import { controlChannelOptions } from "./transport.js";
import { authenticateRunnerPrincipal } from "./runner-authentication.js";
import type { RunnerLeaseLedger } from "../services/runner-lease-ledger.js";
import {
  artifactFromWire,
  artifactToWire,
  endpointVerificationToWire,
  planToWire,
  trafficScopeToWire,
  validationCaseFromWire,
  validationMetricsFromWire,
  validationStatusFromWire,
  validationTestToWire,
} from "./protocol-codec.js";

type RunnerStream = ServerDuplexStream<RunnerMessage__Output, ControllerMessage>;

class PoolIdentityMismatch extends Error {
  constructor() { super("Runner identity is not authorized for the requested pool."); }
}

type ControllerBody = Omit<ControllerMessage, "messageId" | "sentAtUnixMs">;
const SNAPSHOT_ACK_CAPABILITY = "tasklattice.snapshot-ack";
const LEASE_PROBE_CAPABILITY = "tasklattice.lease-probe";
// Experimental protocol values, not verified scheduling or clock bounds.
const LEASE_PROBE_DURATION_MS = 5_000;
const LEASE_PROBE_UNCERTAINTY_MS = 5_000;
type SnapshotDispatch = { nonce: string; generation: number; modelRevisionId: string };

type Connection = {
  sessionId: string;
  stream: RunnerStream;
  runnerId: string;
  bootId: string;
  poolId: string;
  compilerCapable: boolean;
  appliedGeneration: number;
  appliedModelRevisionId: string;
  lastReconcileGeneration: number;
  protectionCapable: boolean;
  appliedProtectionGeneration: number;
  lastProtectionGeneration: number;
  snapshotAckCapable: boolean;
  pendingSnapshot: SnapshotDispatch | null;
  verifiedSnapshot: SnapshotDispatch | null;
  poolAuthenticated: boolean;
  leaseProbeCapable: boolean;
};

export class RunnerControlServer {
  private readonly grpc = new Server(controlChannelOptions);
  private readonly connections = new Map<string, Connection>();
  private timers: NodeJS.Timeout[] = [];
  private dispatchingValidation = false;
  private readonly activeValidations = new Map<string, Connection>();
  private readonly railValidations = new Map<string, { runnerId: string; bootId: string; sessionId: string; finish: (result: RailValidationEvidence) => void }>();
  private readonly admissions = new Map<string, { runnerId: string; bootId: string; sessionId: string; finish: (result: PoolAdmission) => void }>();

  constructor(
    private readonly config: ControllerConfig,
    private readonly service: ControlPlaneService,
    private readonly metrics: ControllerMetrics,
    private readonly models: ModelConfigurationService,
    private readonly leaseLedger?: RunnerLeaseLedger,
  ) {
    if (config.experimentalRunnerLeaseGrants && !leaseLedger) {
      throw new Error("Experimental Runner lease grants require a durable grant ledger.");
    }
    const definition = loadSync(config.protoPath, {
      includeDirs: [dirname(config.protoPath)],
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const descriptor = loadPackageDefinition(definition) as unknown as ProtoGrpcType;
    const handlers: RunnerControlHandlers = {
      Connect: (stream: RunnerStream) => this.connect(stream),
    };
    this.grpc.addService(descriptor.tasklattice.guard.control.v1.RunnerControl.service, handlers);
    this.models.setRailValidator?.((request) => this.validateRail(request));
    this.service.setArtifactAdmission?.((artifact) => this.checkArtifactAdmission(artifact));
  }

  /**
   * Dry-run load one signed Artifact on one connected Runner in every pool.
   * Runner pools receive every Router-referenced Artifact, so each pool must
   * be able to serve it. Prefer Runners that applied the current models.
   */
  async checkArtifactAdmission(artifact: SignedArtifact): Promise<PoolAdmission[]> {
    const expectedByPool = new Map<string, string>();
    const byPool = new Map<string, Connection>();
    const allowed = this.service.groupRouting
      ? new Set((await this.service.groupRouting.poolsForTenant(tenantOwnerForCreate())).map(pool => pool.id))
      : null;
    for (const connection of this.connections.values()) {
      if (allowed && !allowed.has(connection.poolId)) continue;
      if (!await this.isCurrentConnection(connection)) continue;
      if (!expectedByPool.has(connection.poolId)) expectedByPool.set(connection.poolId,
        (await this.runtimeModelsForPool(connection.poolId))?.revisionId ?? "");
      const expectedModelRevisionId = expectedByPool.get(connection.poolId)!;
      const current = byPool.get(connection.poolId);
      if (!current || (current.appliedModelRevisionId !== expectedModelRevisionId && connection.appliedModelRevisionId === expectedModelRevisionId)) {
        byPool.set(connection.poolId, connection);
      }
    }
    const wire = artifactToWire(artifact);
    return Promise.all([...byPool.values()].map(async runner => {
      const unavailable = (reason: string) => ({ poolId: runner.poolId, runnerId: runner.runnerId, admitted: false, unavailable: true, reason, nemoVersion: "", modelRevisionId: "" });
      if (!await this.isCurrentConnection(runner)) return unavailable("The Runner control session changed before the load check could start.");
      return new Promise<PoolAdmission>((resolve) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => finish(unavailable("The Runner did not answer the load check in time.")), 60_000);
        timer.unref();
        const finish = (result: PoolAdmission) => { clearTimeout(timer); this.admissions.delete(requestId); resolve(result); };
        this.admissions.set(requestId, { runnerId: runner.runnerId, bootId: runner.bootId, sessionId: runner.sessionId, finish });
        try { this.write(runner.stream, { artifactAdmissionRequest: { requestId, artifact: wire } }); }
        catch { finish(unavailable("The Runner disconnected before the load check could start.")); }
      });
    }));
  }

  async validateRail(request: CapabilityValidationRequest): Promise<RailValidationEvidence> {
    let runner: Connection | undefined;
    for (const candidate of this.connections.values()) {
      if (candidate.poolId === "default" && candidate.compilerCapable && await this.isCurrentConnection(candidate)) {
        runner = candidate;
        break;
      }
    }
    if (!runner || !request.requestId) return { passed: false, message: "No connected Default Runner can validate this Rail.", latencyMs: 0 };
    if (this.config.runnerPoolTokens != null && (!request.credentialLeaseId ||
      !await this.models.bindValidationLease(request.credentialLeaseId, runner.poolId, {
        poolId: runner.poolId, runnerId: runner.runnerId, bootId: runner.bootId, sessionId: runner.sessionId,
      }))) {
      return { passed: false, message: "The Runner validation credential lease is unavailable.", latencyMs: 0 };
    }
    if (!await this.isCurrentConnection(runner)) return { passed: false, message: "The Runner control session changed before Rail validation could start.", latencyMs: 0 };
    const requestId = request.requestId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ passed: false, message: "Runner Rail validation timed out. No configuration was activated.", latencyMs: 95_000 }), 95_000);
      timer.unref();
      const finish = (result: RailValidationEvidence) => { clearTimeout(timer); this.railValidations.delete(requestId); resolve(result); };
      this.railValidations.set(requestId, { runnerId: runner.runnerId, bootId: runner.bootId, sessionId: runner.sessionId, finish });
      try { this.write(runner.stream, { capabilityValidationRequest: request }); }
      catch { finish({ passed: false, message: "Runner disconnected before Rail validation could start.", latencyMs: 0 }); }
    });
  }

  /** A local connection can have been superseded on another Controller.
   * Rechecking before dispatch narrows that window; it cannot make a database
   * ownership check atomic with a network send or the Runner's work. */
  private async isCurrentConnection(connection: Connection): Promise<boolean> {
    if (this.connections.get(connection.runnerId) !== connection) return false;
    const current = await this.service.runnerControlSessions.isCurrent({ sessionId: connection.sessionId,
      runnerId: connection.runnerId, bootId: connection.bootId, poolId: connection.poolId });
    return current && this.connections.get(connection.runnerId) === connection;
  }

  async start(): Promise<void> {
    const credentials = this.credentials();
    await new Promise<void>((resolve, reject) => {
      this.grpc.bindAsync(`${this.config.grpc.host}:${this.config.grpc.port}`, credentials, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    // A failed tick (for example a database connection timeout) is logged and
    // retried on the next one; it must never take the Controller down.
    const every = (label: string, ms: number, task: () => Promise<unknown> | undefined) =>
      setInterval(() => void Promise.resolve().then(task).catch(error => console.error(`${label} failed`, error)), ms);
    this.timers = [
      every("Validation dispatch", 1_000, () => this.dispatchValidationRequests()),
      every("Desired state dispatch", 1_000, () => this.dispatchDesiredStateChanges()),
      every("Runner reconciliation", 30_000, () => this.reconcileAll()),
      every("Traffic expiry", 30_000, () => this.service.trafficRouting?.expireCalls()),
      every("Endpoint provenance retention", 60_000, () => this.service.pruneEndpointTelemetryContexts?.()),
      every("Stale Runner sweep", this.config.offlineAfterSeconds * 1_000, () => this.service.markStaleRunnersOffline()),
    ];
    for (const timer of this.timers) timer.unref();
  }

  async stop(): Promise<void> {
    for (const validation of this.railValidations.values()) validation.finish({ passed: false, message: "Controller stopped during Rail validation.", latencyMs: 0 });
    for (const [requestId, admission] of this.admissions) admission.finish({ poolId: "", runnerId: admission.runnerId, admitted: false, unavailable: true, reason: `Controller stopped during load check ${requestId}.`, nemoVersion: "", modelRevisionId: "" });
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const connection of this.connections.values()) connection.stream.end();
    await new Promise<void>((resolve) => this.grpc.tryShutdown(() => resolve()));
  }

  hasDefaultCompiler(): boolean {
    return [...this.connections.values()].some((item) => item.poolId === "default" && item.compilerCapable);
  }

  hasCompilerForPools(poolIds: readonly string[]): boolean {
    return [...this.connections.values()].some(item => poolIds.includes(item.poolId) && item.compilerCapable);
  }

  removeRunnerConnection(runnerId: string, bootId: string): void {
    const connection = this.connections.get(runnerId);
    if (!connection || connection.bootId !== bootId) return;
    this.releaseConnection(connection);
    connection.stream.end();
  }

  private releaseConnection(connection: Connection): void {
    this.connections.delete(connection.runnerId);
    for (const [runId, owner] of this.activeValidations) {
      if (owner === connection) this.activeValidations.delete(runId);
    }
    this.metrics.controlConnection(connection.poolId, false);
    for (const validation of this.railValidations.values()) {
      if (validation.sessionId === connection.sessionId)
        validation.finish({ passed: false, message: "Runner disconnected during Rail validation.", latencyMs: 0 });
    }
    for (const admission of this.admissions.values()) {
      if (admission.sessionId === connection.sessionId) admission.finish({ poolId: connection.poolId,
        runnerId: connection.runnerId, admitted: false, unavailable: true,
        reason: "Runner disconnected during the load check.", nemoVersion: "", modelRevisionId: "" });
    }
  }

  async distributeProtectionModes(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map(connection => this.reconcileProtectionModes(connection)));
  }

  private async reconcileProtectionModes(connection: Connection): Promise<void> {
    if (!connection.protectionCapable || !this.service.protectionModes) return;
    const protection = await this.service.protectionModes.desiredState(connection.poolId);
    if (this.connections.get(connection.runnerId) !== connection) return;
    if (!await this.service.runnerControlSessions.isCurrent({ sessionId: connection.sessionId,
      runnerId: connection.runnerId, bootId: connection.bootId, poolId: connection.poolId })) return;
    if (connection.lastProtectionGeneration < protection.generation) {
      this.write(connection.stream, { protectionState: { generation: String(protection.generation), modes: protection.modes } });
      connection.lastProtectionGeneration = protection.generation;
    }
  }

  private runtimeModelsForPool(poolId: string, tx?: GroupModelTransaction) {
    // Legacy internal adapters predate group policy support. The production
    // Model service always exposes configurationForPool, whose explicit
    // blocked/null results are authoritative and never trigger a fallback.
    return this.models.configurationForPool
      ? this.models.configurationForPool(poolId, true, tx)
      : this.models.activeConfiguration(true);
  }

  private async currentPoolConnections(poolId: string): Promise<Connection[]> {
    const candidates = [...this.connections.values()].filter(item => item.poolId === poolId);
    const checked = await Promise.all(candidates.map(async connection => await this.isCurrentConnection(connection) ? connection : null));
    return checked.filter((connection): connection is Connection => connection !== null);
  }

  async distributeDesiredState(poolId = "default", timeoutMs = 2_500, expectedRevisionId?: string): Promise<{
    desiredGeneration: number;
    distributionStatus: "ready" | "syncing";
  }> {
    const desiredGeneration = await this.service.desiredGeneration();
    const expectedModelRevisionId = expectedRevisionId ?? (await this.runtimeModelsForPool(poolId))?.revisionId ?? "";
    await this.dispatchDesiredStateChanges();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const runners = await this.currentPoolConnections(poolId);
      if (runners.length > 0 && runners.every((item) => (
        item.appliedGeneration >= desiredGeneration
        && item.appliedModelRevisionId === expectedModelRevisionId
      ))) {
        return { desiredGeneration, distributionStatus: "ready" };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { desiredGeneration, distributionStatus: "syncing" };
  }

  async distributionStatus(poolId = "default"): Promise<{
    desiredGeneration: number;
    distributionStatus: "ready" | "syncing";
  }> {
    const desiredGeneration = await this.service.desiredGeneration();
    const expectedModelRevisionId = (await this.runtimeModelsForPool(poolId))?.revisionId ?? "";
    const runners = await this.currentPoolConnections(poolId);
    return {
      desiredGeneration,
      distributionStatus: runners.length > 0 && runners.every((item) => (
        item.appliedGeneration >= desiredGeneration
        && item.appliedModelRevisionId === expectedModelRevisionId
      ))
        ? "ready"
        : "syncing",
    };
  }

  private connect(stream: RunnerStream): void {
    const authorization = stream.metadata.get("authorization")[0];
    const principal = authenticateRunnerPrincipal(authorization, this.config);
    if (!principal) {
      this.metrics.observeControlMessage("received", "authentication", "rejected");
      const error = Object.assign(new Error("Runner authentication failed."), { code: status.UNAUTHENTICATED });
      // grpc-js sends the final gRPC status from its error handler. Destroying
      // the duplex stream here can leave the client waiting until its deadline.
      stream.emit("error", error);
      return;
    }
    let connection: Connection | null = null;
    let streamClosed = false;
    let messageChain = Promise.resolve();
    stream.on("data", (message: RunnerMessage__Output) => {
      if (streamClosed) return;
      const messageType = message.body ?? "unknown";
      messageChain = messageChain.then(async () => {
        const registered = await this.handleMessage(stream, message, connection, principal.poolId);
        if (registered) {
          connection = registered;
          if (streamClosed) {
            if (this.connections.get(registered.runnerId) === registered) this.releaseConnection(registered);
            await this.service.disconnectRunner(registered.runnerId, registered.bootId, registered.sessionId);
          }
        }
        this.metrics.observeControlMessage("received", messageType);
      }).catch((error: unknown) => {
        this.metrics.observeControlMessage("received", messageType, "error");
        const detail = error instanceof Error ? error.message : "Unknown Runner control error.";
        const denied = error instanceof PoolIdentityMismatch;
        stream.emit("error", Object.assign(new Error(detail), { code: denied ? status.PERMISSION_DENIED : status.INTERNAL }));
      });
    });
    const disconnected = () => {
      streamClosed = true;
      // A removed/replaced stream may close after the same process reconnects.
      if (!connection || this.connections.get(connection.runnerId) !== connection) return;
      this.releaseConnection(connection);
      void this.service.disconnectRunner(connection.runnerId, connection.bootId, connection.sessionId);
    };
    stream.once("end", disconnected);
    stream.once("close", disconnected);
    stream.once("error", disconnected);
  }

  private async handleMessage(
    stream: RunnerStream,
    message: RunnerMessage__Output,
    current: Connection | null,
    authorizedPoolId: string | null = null,
  ): Promise<Connection | null> {
    if (message.registration) {
      if (current) throw new Error("Runner registered more than once on one stream.");
      const registration = message.registration;
      if (authorizedPoolId !== null && registration.poolId !== authorizedPoolId) throw new PoolIdentityMismatch();
      const sessionId = randomUUID();
      const desiredGeneration = await this.service.registerRunner({
        runnerId: registration.runnerId,
        bootId: registration.bootId,
        poolId: registration.poolId,
        runnerVersion: registration.runnerVersion,
        nemoVersion: registration.nemoVersion,
        maxConcurrency: number(registration.maxConcurrency),
        compilerCapable: registration.compilerCapable,
        labels: registration.labels ?? {},
        appliedGeneration: number(registration.appliedGeneration),
      }, sessionId);
      const connection: Connection = {
        sessionId,
        stream,
        runnerId: registration.runnerId,
        bootId: registration.bootId,
        poolId: registration.poolId,
        compilerCapable: registration.compilerCapable,
        appliedGeneration: number(registration.appliedGeneration),
        appliedModelRevisionId: "",
        lastReconcileGeneration: -1,
        protectionCapable: registration.labels?.[PROTECTION_MODE_CAPABILITY] === "1",
        appliedProtectionGeneration: number(registration.appliedProtectionGeneration),
        lastProtectionGeneration: -1,
        snapshotAckCapable: registration.labels?.[SNAPSHOT_ACK_CAPABILITY] === "1",
        pendingSnapshot: null,
        verifiedSnapshot: null,
        poolAuthenticated: authorizedPoolId !== null,
        leaseProbeCapable: registration.labels?.[LEASE_PROBE_CAPABILITY] === "1",
      };
      const prior = this.connections.get(connection.runnerId);
      if (prior) this.releaseConnection(prior);
      this.connections.set(connection.runnerId, connection);
      this.metrics.controlConnection(connection.poolId, true);
      try {
        const telemetry = registration.telemetryWalId ? await (async () => {
          if (!this.config.runnerTelemetryProgress || !this.config.runnerScopedTelemetry || !connection.poolAuthenticated) {
            throw new Error("Authenticated telemetry progress is unavailable for this registration.");
          }
          return this.service.telemetryProgress.issue({ sessionId, runnerId: connection.runnerId,
            bootId: connection.bootId, poolId: connection.poolId }, registration.telemetryWalId!);
        })() : null;
        this.write(stream, {
          registrationAccepted: {
            desiredGeneration: String(desiredGeneration),
            heartbeatIntervalSeconds: this.config.heartbeatIntervalSeconds,
            ...(telemetry ? { telemetryUploadAuthorization: { walId: telemetry.walId, capability: telemetry.capability,
              acknowledgedCursor: String(telemetry.acknowledgedCursor), producedCursor: String(telemetry.producedCursor),
              lastBatchId: telemetry.lastBatchId, lastBatchDigest: telemetry.lastBatchDigest } } : {}),
          },
        });
        await this.reconcile(connection);
        return connection;
      } catch (error) {
        // The outer stream handler does not receive the Connection until this
        // method returns. Clean up a committed registration if initial send or
        // reconciliation fails, including when the stream already ended.
        if (this.connections.get(connection.runnerId) === connection) this.releaseConnection(connection);
        await this.service.disconnectRunner(connection.runnerId, connection.bootId, connection.sessionId);
        throw error;
      }
    }
    if (!current) throw new Error("Runner must register before sending control messages.");
    if (this.connections.get(current.runnerId) !== current) return null;
    if (!await this.service.runnerControlSessions.isCurrent({ sessionId: current.sessionId,
      runnerId: current.runnerId, bootId: current.bootId, poolId: current.poolId })) return null;
    if (message.heartbeat) {
      const heartbeat = message.heartbeat;
      if (heartbeat.runnerId !== current.runnerId || heartbeat.bootId !== current.bootId) {
        throw new Error("Heartbeat identity does not match the registered stream.");
      }
      try {
        const accepted = await this.service.recordHeartbeat({
          runnerId: heartbeat.runnerId,
          bootId: heartbeat.bootId,
          controlSessionId: current.sessionId,
          sequence: number(heartbeat.sequence),
          appliedGeneration: number(heartbeat.appliedGeneration),
          load: normalizeLoad(heartbeat.load),
          admissionSnapshot: heartbeat.tenantAdmissionSnapshotJson,
        });
        this.metrics.observeHeartbeat(current.poolId, accepted ? "accepted" : "stale_or_unknown");
        if (!accepted) return null;
      } catch (error) {
        this.metrics.observeHeartbeat(current.poolId, "error");
        throw error;
      }
      current.appliedGeneration = number(heartbeat.appliedGeneration);
      if (current.protectionCapable) {
        current.appliedProtectionGeneration = number(heartbeat.appliedProtectionGeneration);
        await this.service.protectionModes?.recordResult({ runnerId: current.runnerId, bootId: current.bootId,
          generation: current.appliedProtectionGeneration, accepted: true });
      }
      const desired = await this.service.desiredGeneration();
      if (number(heartbeat.appliedGeneration) !== desired || (current.protectionCapable && current.appliedProtectionGeneration !== desired)) await this.reconcile(current);
    } else if (message.protectionResult) {
      const result = message.protectionResult;
      const generation = number(result.generation);
      if (result.runnerId !== current.runnerId || !current.protectionCapable || generation > current.lastProtectionGeneration) {
        throw new Error("Protection-mode result does not match the registered Runner and dispatched generation.");
      }
      await this.service.protectionModes.recordResult({ runnerId: current.runnerId, bootId: current.bootId,
        generation, accepted: result.accepted, reason: result.reason });
      if (result.accepted) current.appliedProtectionGeneration = Math.max(current.appliedProtectionGeneration, generation);
    } else if (message.validationProgress) {
      const progress = message.validationProgress;
      if (progress.runnerId !== current.runnerId || !current.compilerCapable) {
        throw new Error("Validation progress identity does not match a registered compiler stream.");
      }
      const owner = this.activeValidations.get(progress.runId);
      // A current compiler stream is not authority for an arbitrary run ID.
      // Unknown, completed and disconnected assignments must not be revived.
      if (!owner) return null;
      if (owner !== current) throw new Error("Validation progress belongs to another Runner stream.");
      const phase = {
        VALIDATION_EXECUTION_PHASE_PREPARING: "preparing",
        VALIDATION_EXECUTION_PHASE_EXECUTING: "executing",
        VALIDATION_EXECUTION_PHASE_FINALIZING: "finalizing",
      } as const;
      if (progress.phase === "VALIDATION_EXECUTION_PHASE_UNSPECIFIED") return current;
      await this.service.updateValidationProgress(progress.runId, {
        phase: phase[progress.phase], completedCases: progress.completedCases, passedCases: progress.passedCases,
      });
    } else if (message.validationResult) {
      const result = message.validationResult;
      if (result.runnerId !== current.runnerId || !current.compilerCapable) throw new Error("Validation result identity does not match a registered compiler stream.");
      const owner = this.activeValidations.get(result.runId);
      if (!owner) return null;
      if (owner !== current) throw new Error("Validation result belongs to another Runner stream.");
      this.metrics.observeJob("validation", result.accepted);
      await this.handleValidationResult(result);
      this.activeValidations.delete(result.runId);
    } else if (message.artifactAdmissionResult) {
      const result = message.artifactAdmissionResult;
      const pending = this.admissions.get(result.requestId);
      if (pending && pending.runnerId === current.runnerId && pending.bootId === current.bootId && pending.sessionId === current.sessionId) {
        pending.finish({ poolId: current.poolId, runnerId: current.runnerId, admitted: result.admitted, unavailable: false,
          reason: result.reason, nemoVersion: result.nemoVersion, modelRevisionId: result.modelRevisionId });
      }
    } else if (message.capabilityValidationResult) {
      const result = message.capabilityValidationResult;
      const pending = this.railValidations.get(result.requestId);
      if (pending && pending.runnerId === current.runnerId && pending.bootId === current.bootId && pending.sessionId === current.sessionId) {
        const passed = result.passed && Boolean(result.runtimeProfile)
          && result.cases.some((item) => item.expectedDecision === "allow")
          && result.cases.some((item) => item.expectedDecision === "block")
          && result.cases.every((item) => item.passed && item.expectedDecision === item.actualDecision);
        pending.finish({ passed, message: result.message, latencyMs: result.latencyMs, cases: result.cases });
      }
    } else if (message.artifactResult) {
      // The following heartbeat advances applied_generation after an atomic
      // activation. NACK keeps the prior last-known-good generation in place.
      const result = message.artifactResult as { accepted?: boolean };
      this.metrics.observeArtifactResult(current.poolId, Boolean(result.accepted));
      if (result.accepted) await this.reconcile(current);
      else current.lastReconcileGeneration = -1;
    } else if (message.servingLeaseRequest) {
      const request = message.servingLeaseRequest;
      const snapshot = current.verifiedSnapshot;
      const epoch = Number(request.epoch), generation = Number(request.generation);
      const canRespond = () => this.connections.get(current.runnerId) === current && current.stream === stream;
      const reject = () => {
        if (canRespond()) this.write(stream, { servingLeaseResponse: {
          nonce: request.nonce, granted: false, epoch: request.epoch, generation: request.generation,
          snapshotNonce: request.snapshotNonce, durationMs: 0,
        } });
      };
      if (!this.config.experimentalRunnerLeaseGrants || !this.leaseLedger || !current.poolAuthenticated ||
          !current.leaseProbeCapable || !current.snapshotAckCapable || !snapshot ||
          request.runnerId !== current.runnerId || request.bootId !== current.bootId ||
          !Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(generation) || generation < 0 ||
          request.snapshotNonce !== snapshot.nonce || generation !== snapshot.generation) {
        reject();
        return null;
      }
      try {
        await this.leaseLedger.issueSnapshotBound({ poolId: current.poolId, runnerId: current.runnerId,
          bootId: current.bootId, controlSessionId: current.sessionId, nonce: request.nonce, epoch, generation,
          snapshotNonce: snapshot.nonce, modelRevisionId: snapshot.modelRevisionId,
          durationMs: LEASE_PROBE_DURATION_MS, uncertaintyMs: LEASE_PROBE_UNCERTAINTY_MS });
      } catch {
        reject();
        return null;
      }
      // Never discard the durable grant: even a reply suppressed by a
      // disconnect or replacement must remain outstanding in the ledger.
      if (canRespond() && current.verifiedSnapshot === snapshot && await this.service.runnerControlSessions.isCurrent({
        sessionId: current.sessionId, runnerId: current.runnerId, bootId: current.bootId, poolId: current.poolId })) {
        this.write(stream, { servingLeaseResponse: { nonce: request.nonce, granted: true,
          epoch: request.epoch, generation: request.generation, snapshotNonce: snapshot.nonce,
          durationMs: LEASE_PROBE_DURATION_MS } });
      }
    } else if (message.desiredStateResult) {
      const result = message.desiredStateResult;
      if (result.runnerId !== current.runnerId) {
        throw new Error("Desired-state result identity does not match the registered stream.");
      }
      const generation = number(result.generation);
      if (current.snapshotAckCapable) {
        const pending = current.pendingSnapshot;
        // These observations are groundwork only; no lease or serving right
        // follows from an ACK. Only the most recently sent snapshot on this
        // authenticated stream is accepted; stale/replayed ACKs are ignored.
        if (!pending || !result.snapshotNonce || result.snapshotNonce !== pending.nonce ||
            generation !== pending.generation || result.modelRevisionId !== pending.modelRevisionId) return null;
        if (!await this.service.runnerControlSessions.acknowledged({ sessionId: current.sessionId,
          runnerId: current.runnerId, bootId: current.bootId, poolId: current.poolId,
          nonce: pending.nonce, generation, modelRevisionId: pending.modelRevisionId, accepted: result.accepted })) return null;
        if (this.connections.get(current.runnerId) !== current || current.pendingSnapshot !== pending) return null;
        current.pendingSnapshot = null;
        current.verifiedSnapshot = result.accepted ? pending : null;
      }
      if (result.accepted) {
        current.appliedGeneration = Math.max(current.appliedGeneration, generation);
        current.appliedModelRevisionId = result.modelRevisionId;
        if (result.modelRevisionId && !isGroupRuntimeConfigurationId(result.modelRevisionId)) {
          const peers = [...this.connections.values()].filter((item) => item.poolId === current.poolId);
          if (peers.length > 0 && peers.every((item) => (
            item.appliedGeneration >= generation
            && item.appliedModelRevisionId === result.modelRevisionId
          ))) {
            await this.models.finalizeActivation(result.modelRevisionId, current.poolId);
          }
        }
      } else {
        await this.service.trafficRouting?.reportRolloutFailure?.(
          generation, current.runnerId,
          result.reason || `Runner ${current.runnerId} rejected desired generation ${generation}.`,
          { poolId: current.poolId, bootId: current.bootId, controlSessionId: current.sessionId },
        );
        if (result.modelRevisionId && !isGroupRuntimeConfigurationId(result.modelRevisionId)) {
          await this.models.failActivation(
            result.modelRevisionId,
            result.reason || `Runner ${current.runnerId} rejected desired generation ${generation}.`,
            current.poolId,
          );
        }
        for (const connection of this.connections.values()) connection.lastReconcileGeneration = -1;
        await this.reconcileAll();
      }
    }
    return null;
  }

  private async handleValidationResult(result: ValidationResult__Output): Promise<void> {
    if (!result.accepted) {
      await this.service.rejectValidation({
        runId: result.runId,
        reason: result.reason || "GuardRails 0 could not execute Guardrail Validation.",
      });
      return;
    }
    if (!result.metrics) throw new Error("Accepted Validation result is missing metrics.");
    const metrics = validationMetricsFromWire(result.metrics);
    const results = result.results.map(validationCaseFromWire);
    await this.service.completeValidation({
      runId: result.runId,
      status: validationStatusFromWire(result.status),
      metrics,
      results,
      ...(result.testScope ? { testScope: { ...result.testScope, skippedRules: result.testScope.skippedRules.map(r => ({ ...r })) } } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.candidateArtifact ? { candidateArtifact: artifactFromWire(result.candidateArtifact) as unknown as ArtifactContent } : {}),
      ...(result.runtime ? { runtime: {
        runnerId: result.runtime.runnerId, runnerVersion: result.runtime.runnerVersion, nemoVersion: result.runtime.nemoVersion,
        modelRevisionId: result.runtime.modelRevisionId, compilerModelTypes: [...result.runtime.compilerModelTypes],
      } } : {}),
    });
  }

  private async reconcileAll(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((connection) => this.reconcile(connection)));
  }

  private async reconcile(connection: Connection): Promise<void> {
    const started = performance.now();
    try {
      if (!await this.service.runnerControlSessions.isCurrent({ sessionId: connection.sessionId,
        runnerId: connection.runnerId, bootId: connection.bootId, poolId: connection.poolId })) return;
      // Send the operating overlay before materializing any model/Artifact state.
      // Old Runners cannot ACK this message and remain visibly unsupported.
      await this.reconcileProtectionModes(connection);
      const desiredUnknown = await this.service.desiredStateForPool(connection.poolId,
        tx => this.runtimeModelsForPool(connection.poolId, tx));
      if (this.connections.get(connection.runnerId) !== connection) return;
      // The transaction wrapper intentionally exposes an opaque result type in
      // the database adapter. Keep the wire projection typed at this boundary.
      const desired = desiredUnknown as Awaited<ReturnType<ControlPlaneService["desiredStateForPool"]>> & {
        routerRevisions?: Array<any>;
        endpoints: Array<any>;
      };
      // The real service resolves both in one allocation/generation transaction.
      // Older internal test adapters return only desired state; they retain the
      // legacy model-service adapter path. A resolved null never falls back.
      const modelConfiguration = Object.hasOwn(desired, "runtimeModelConfiguration")
        ? desired.runtimeModelConfiguration ?? null : await this.runtimeModelsForPool(connection.poolId);
      if (modelConfiguration && isGroupRuntimeConfigurationId(modelConfiguration.revisionId) && !connection.snapshotAckCapable)
        throw new Error("Group runtime Models require a Runner with challenged snapshot acknowledgement support.");
      if (connection.lastReconcileGeneration === desired.generation) {
        this.metrics.observeReconcile(connection.poolId, "noop", (performance.now() - started) / 1_000);
        return;
      }
      const dataBindings = modelConfiguration ? capabilityBindingDefinitions.flatMap((binding) => {
        const modelRef = modelConfiguration.assignments.bindings[binding.id];
        if (!modelRef) return [];
        const model = modelConfiguration.models.find((item) => item.id === modelRef);
        if (!model) return [];
        return [{
          bindingId: binding.id,
          capabilityRef: binding.capabilityRef,
          railType: binding.railType === "input" ? "RAIL_TYPE_INPUT" as const : "RAIL_TYPE_OUTPUT" as const,
          implementationRef: binding.implementationRef,
          modelRef,
          profileRef: model.profile,
          contractRefs: [...capabilityBindingContracts(binding.id, model.profile)],
        }];
      }) : [];
      const dataModelIds = new Set(dataBindings.map((item) => item.modelRef));
      const snapshot = connection.snapshotAckCapable ? { nonce: randomUUID(), generation: desired.generation,
        modelRevisionId: modelConfiguration?.revisionId ?? "" } : null;
      const allocation = snapshot ? await this.service.runnerControlSessions.dispatchedAllocation({ sessionId: connection.sessionId,
        runnerId: connection.runnerId, bootId: connection.bootId, poolId: connection.poolId, ...snapshot }) : null;
      if (snapshot && !allocation) return;
      if (snapshot && (allocation!.groupId !== desired.groupId ||
          (desired.allocationEpoch !== undefined && allocation!.epoch !== desired.allocationEpoch))) return;
      if (this.connections.get(connection.runnerId) !== connection) return;
      connection.pendingSnapshot = snapshot;
      connection.verifiedSnapshot = null;
      try { this.write(connection.stream, {
      desiredState: {
        generation: String(desired.generation),
        ...(snapshot ? { snapshotNonce: snapshot.nonce, allocationEpoch: String(allocation!.epoch),
          allocationGroupId: allocation!.groupId } : {}),
        artifacts: desired.artifacts.map((artifact) => artifactToWire(artifact)),
        disabledGuardrailIds: desired.disabledGuardrailIds,
        disabledEndpointIds: desired.disabledEndpointIds,
        routerRevisions: (desired.routerRevisions ?? []).map((router) => ({
          routerId: router.routerId, revision: String(router.revision),
          assignmentAlgorithm: router.assignmentAlgorithm,
          assignmentKeyId: router.assignmentKeyId, assignmentKey: router.assignmentKey,
          routes: router.routes.map((route) => ({
            routeId: route.id, name: route.name, kind: route.kind, enabled: route.enabled,
            allEndpoints: true,
            endpointIds: [],
            trafficScope: trafficScopeToWire(route.selector.expression),
            targets: route.targets.map((target) => ({
              targetId: target.id, guardrailId: target.guardrailId,
              guardrailVersion: target.guardrailVersion, artifactId: target.artifactId,
              weightBps: target.weightBps,
            })),
          })),
        })),
        endpoints: desired.endpoints.map((endpoint) => ({
          endpointId: endpoint.endpointId,
          tenantId: endpoint.tenantId,
          ...(endpoint.telemetryContextId ? { telemetryContextId: endpoint.telemetryContextId } : {}),
          adapter: endpoint.adapter,
          routerId: endpoint.trafficRouterId ?? "",
          verification: endpointVerificationToWire(endpoint.verification),
          scanFlagOnlyDefault: endpoint.scanFlagOnlyDefault,
        })),
        guardrailLoggingLevels: desired.guardrailLoggingLevels,
        modelConfiguration: modelConfiguration ? {
          revisionId: modelConfiguration.revisionId,
          revision: modelConfiguration.revision,
          runtimes: modelConfiguration.models.filter((model) => dataModelIds.has(model.id)).map((model) => ({
            id: model.id,
            providerId: model.providerId,
            providerName: model.providerName,
            baseUrl: model.baseUrl,
            credentialRef: model.credentialRef,
            skipTlsVerify: model.skipTlsVerify ?? false,
            model: model.model,
            profileRef: model.profile,
            timeoutSeconds: model.timeoutSeconds,
            maxTokens: model.maxTokens,
          })),
          bindings: dataBindings,
        } : null,
      },
      }); } catch (error) {
        connection.pendingSnapshot = null;
        throw error;
      }
      connection.lastReconcileGeneration = desired.generation;
      this.metrics.observeReconcile(connection.poolId, "dispatched", (performance.now() - started) / 1_000);
    } catch (error) {
      this.metrics.observeReconcile(connection.poolId, "error", (performance.now() - started) / 1_000);
      throw error;
    }
  }

  private async dispatchValidationRequests(): Promise<void> {
    // Timer ticks may overlap while PostgreSQL is slow. Reserve a single job per
    // compiler until its result is committed or the stream disconnects.
    if (this.dispatchingValidation) return;
    this.dispatchingValidation = true;
    try {
      const busy = new Set(this.activeValidations.values());
      const excludedRunIds = [...this.activeValidations.keys()];
      const events = [
        ...await this.service.pendingOutbox("guardrail.validation_requested", 50, excludedRunIds),
        ...await this.service.pendingOutbox("policy.validation_requested", 50, excludedRunIds),
      ].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
      let event: typeof events[number] | undefined;
      let compiler: Connection | undefined;
      for (const candidate of events) {
        if (this.activeValidations.has(string(candidate.payload.runId))) continue;
        const poolIds = this.service.groupRouting
          ? await this.service.groupRouting.poolsForValidation(candidate.kind, candidate.aggregateId)
          : ["default"];
        for (const connection of this.connections.values()) {
          if (poolIds.includes(connection.poolId) && connection.compilerCapable && !busy.has(connection) &&
              await this.isCurrentConnection(connection)) {
            compiler = connection;
            break;
          }
        }
        if (compiler) { event = candidate; break; }
      }
      if (!event || !compiler) return;
      const payload = event.payload;
      const runId = string(payload.runId);
      try {
        await this.service.markValidationRunning(event.id);
        await this.service.deferOutbox(event.id, 30);
        if (!await this.isCurrentConnection(compiler)) {
          return;
        }
        // The dispatch loop is serialized separately. Do not authorize results
        // while bookkeeping is still awaiting: the compiler has not received
        // this request yet and a guessed run ID must not complete it early.
        this.activeValidations.set(runId, compiler);
        this.write(compiler.stream, {
          validationRequest: {
            runId,
            guardrailId: string(payload.guardrailId),
            candidateVersion: string(payload.candidateVersion),
            sourceDraftRevision: number(payload.sourceDraftRevision),
            ...(payload.artifact ? { artifact: artifactToWire(payload.artifact) } : { plan: planToWire(payload.plan ?? {}) }),
            runtimeProfile: string(payload.runtimeProfile),
            testCases: array(payload.testCases).map(validationTestToWire),
            testModelRules: payload.testModelRules !== false,
          },
        });
      } catch (error) {
        this.activeValidations.delete(runId);
        throw error;
      }
    } finally {
      this.dispatchingValidation = false;
    }
  }

  private async dispatchDesiredStateChanges(): Promise<void> {
    const events = await this.service.pendingOutbox("runner.desired_state_changed", 50);
    if (events.length === 0) return;
    for (const connection of this.connections.values()) connection.lastReconcileGeneration = -1;
    await this.reconcileAll();
    await Promise.all(events.map((event) => this.service.markOutboxProcessed(event.id)));
  }

  private write(stream: RunnerStream, body: ControllerBody): void {
    stream.write({ messageId: randomUUID(), sentAtUnixMs: String(Date.now()), ...body });
    this.metrics.observeControlMessage("sent", wireMessageType(body));
  }

  private credentials(): ServerCredentials {
    if (this.config.grpcTls) {
      return ServerCredentials.createSsl(
        readFileSync(this.config.grpcTls.clientCaPath),
        [{
          cert_chain: readFileSync(this.config.grpcTls.certPath),
          private_key: readFileSync(this.config.grpcTls.keyPath),
        }],
        true,
      );
    }
    if (this.config.grpcTransport === "mtls") {
      throw new Error("Controller gRPC mTLS certificate, key, and client CA are required in mtls mode.");
    }
    return ServerCredentials.createInsecure();
  }
}

function normalizeLoad(load: RunnerHeartbeat__Output["load"]): RunnerLoad {
  return {
    inflight: number(load?.inflight),
    maxConcurrency: number(load?.maxConcurrency),
    queueDepth: number(load?.queueDepth),
    requestsDelta: number(load?.requestsDelta),
    errorsDelta: number(load?.errorsDelta),
    timeoutsDelta: number(load?.timeoutsDelta),
    latencyP95Ms: number(load?.latencyP95Ms),
    cpuUtilization: number(load?.cpuUtilization),
    memoryUtilization: number(load?.memoryUtilization),
    activeGuardrails: number(load?.activeGuardrails),
    compileQueueDepth: number(load?.compileQueueDepth),
    observationIntervalMs: number(load?.observationIntervalMs),
  };
}

function wireMessageType(message: ControllerBody): string {
  return [
    "registrationAccepted", "desiredState", "protectionState", "validationRequest", "drainRequest",
  ].find((key) => key in message) ?? "unknown";
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
