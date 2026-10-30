import { PROTECTION_MODE_CAPABILITY } from "../../shared/protection-mode.js";
import { artifactExecutionContractIssue } from "../domain/artifact-execution-contract.js";
import { OFFLINE_COMPILATION_CAPABILITY, type ArtifactCompilation } from "../domain/artifact-compilation.js";
import { readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import {
  Server,
  ServerCredentials,
  type ServerDuplexStream,
  status,
  loadPackageDefinition,
} from "@grpc/grpc-js";
import { loadSync, type MessageTypeDefinition } from "@grpc/proto-loader";

import type { ControllerConfig } from "../config.js";
import { databaseErrorFields, logDatabaseFailure } from "../db/diagnostics.js";
import { KeyedWorkQueue, PendingWork } from "../work-queue.js";
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
import type { PoolAdmission, SignedArtifact } from "../domain/environment-check.js";
import { controlChannelOptions } from "./transport.js";
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

const decompressReport = promisify(gunzip);
const MAX_REPORT_BYTES = 128 * 1024 * 1024;
type RunnerStream = ServerDuplexStream<RunnerMessage__Output, ControllerMessage>;
type ControllerBody = Omit<ControllerMessage, "messageId" | "sentAtUnixMs">;

type Connection = {
  stream: RunnerStream;
  runnerId: string;
  bootId: string;
  poolId: string;
  compilerCapable: boolean;
  offlineCompilation?: boolean;
  appliedGeneration: number;
  appliedModelRevisionId: string;
  lastReconcileGeneration: number;
  protectionCapable: boolean;
  appliedProtectionGeneration: number;
  lastProtectionGeneration: number;
};

export class RunnerControlServer {
  private readonly grpc = new Server(controlChannelOptions);
  private readonly validationResultCodec: MessageTypeDefinition<object, ValidationResult__Output>;
  private readonly connections = new Map<string, Connection>();
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private stopJob: Promise<void> | undefined;
  private readonly pending = new PendingWork();
  private readonly streams = new Map<RunnerStream, () => void>();
  private readonly syncQueue: KeyedWorkQueue<object>;
  private readonly protectionKeys = new WeakMap<Connection, object>();
  private dispatchingValidation = false;
  private readonly activeValidations = new Map<string, Connection>();
  private readonly railValidations = new Map<string, { runnerId: string; bootId: string; finish: (result: RailValidationEvidence) => void }>();
  private readonly admissions = new Map<string, { runnerId: string; bootId: string; finish: (result: PoolAdmission) => void }>();
  private readonly compilations = new Map<string, { runnerId: string; bootId: string; finish: (artifact?: ArtifactContent, error?: string) => void }>();

  constructor(
    private readonly config: ControllerConfig,
    private readonly service: ControlPlaneService,
    private readonly metrics: ControllerMetrics,
    private readonly models: ModelConfigurationService,
  ) {
    this.syncQueue = new KeyedWorkQueue(config.runnerSyncConcurrency ?? 4);
    const definition = loadSync(config.protoPath, {
      includeDirs: [dirname(config.protoPath)],
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    this.validationResultCodec = definition["tasklattice.guard.control.v1.ValidationResult"] as MessageTypeDefinition<object, ValidationResult__Output>;
    const descriptor = loadPackageDefinition(definition) as unknown as ProtoGrpcType;
    const handlers: RunnerControlHandlers = {
      Connect: (stream: RunnerStream) => this.connect(stream),
    };
    this.grpc.addService(descriptor.tasklattice.guard.control.v1.RunnerControl.service, handlers);
    this.models.setRailValidator?.((request) => this.validateRail(request));
    this.service.setArtifactAdmission?.((artifact) => this.checkArtifactAdmission(artifact));
    this.service.setArtifactCompiler?.((request) => this.compileArtifact(request));
  }

  async compileArtifact(input: ArtifactCompilation): Promise<ArtifactContent> {
    if (this.stopping) throw new Error("Controller is stopping");
    const runner = [...this.connections.values()].find(item => item.poolId === "default" && item.compilerCapable && item.offlineCompilation);
    if (!runner) throw new ConflictError("Connect an upgraded compiler Runner to publish this draft. Tests are optional.", "guardrail_compiler_unavailable");
    return new Promise((resolve, reject) => {
      const compileId = randomUUID();
      const timer = setTimeout(() => finish(undefined, "Compilation timed out. Retry publication."), 60_000);
      timer.unref();
      const finish = (artifact?: ArtifactContent, error?: string) => {
        clearTimeout(timer);
        this.compilations.delete(compileId);
        if (artifact && !error) resolve(artifact);
        else reject(new ConflictError(error || "Compilation returned no Artifact.", "guardrail_compilation_failed"));
      };
      this.compilations.set(compileId, { runnerId: runner.runnerId, bootId: runner.bootId, finish });
      try { this.write(runner.stream, { artifactCompilationRequest: { compileId, ...input, generation: "0", plan: planToWire(input.plan) } }); }
      catch { finish(undefined, "Runner disconnected before compilation. Retry publication."); }
    });
  }

  /**
   * Dry-run load one signed Artifact on one connected Runner in every pool.
   * Runner pools receive every Router-referenced Artifact, so each pool must
   * be able to serve it. Check only Runners that applied the current models.
   */
  async checkArtifactAdmission(artifact: SignedArtifact): Promise<PoolAdmission[]> {
    if (this.stopping) throw new Error("Controller is stopping");
    const contractIssue = artifactExecutionContractIssue(artifact);
    const expectedModelRevisionId = (await this.models.activeConfiguration(true))?.revisionId ?? "";
    if (this.stopping) throw new Error("Controller is stopping");
    const byPool = new Map<string, Connection>();
    for (const connection of this.connections.values()) {
      const current = byPool.get(connection.poolId);
      if (!current || (current.appliedModelRevisionId !== expectedModelRevisionId && connection.appliedModelRevisionId === expectedModelRevisionId)) {
        byPool.set(connection.poolId, connection);
      }
    }
    return Promise.all([...byPool.values()].map((runner) => new Promise<PoolAdmission>((resolve) => {
      const requestId = randomUUID();
      const unavailable = (reason: string) => ({ poolId: runner.poolId, runnerId: runner.runnerId, admitted: false, unavailable: true, reason, nemoVersion: "", modelRevisionId: "" });
      if (contractIssue) {
        resolve({ ...unavailable(contractIssue), unavailable: false });
        return;
      }
      const wire = artifactToWire(artifact);
      if (runner.appliedModelRevisionId !== expectedModelRevisionId) {
        resolve(unavailable("The Runner is still applying the current model assignments. The environment check will retry after synchronization."));
        return;
      }
      const timer = setTimeout(() => finish(unavailable("The Runner did not answer the load check in time.")), 60_000);
      timer.unref();
      const finish = (result: PoolAdmission) => { clearTimeout(timer); this.admissions.delete(requestId); resolve(result); };
      this.admissions.set(requestId, { runnerId: runner.runnerId, bootId: runner.bootId, finish });
      try { this.write(runner.stream, { artifactAdmissionRequest: { requestId, artifact: wire } }); }
      catch { finish(unavailable("The Runner disconnected before the load check could start.")); }
    })));
  }

  async validateRail(request: CapabilityValidationRequest): Promise<RailValidationEvidence> {
    if (this.stopping) throw new Error("Controller is stopping");
    const runner = [...this.connections.values()].find((item) => item.poolId === "default" && item.compilerCapable);
    if (!runner || !request.requestId) return { passed: false, message: "No connected Default Runner can validate this Rail.", latencyMs: 0 };
    const requestId = request.requestId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ passed: false, message: "Runner Rail validation timed out. No configuration was activated.", latencyMs: 95_000 }), 95_000);
      timer.unref();
      const finish = (result: RailValidationEvidence) => { clearTimeout(timer); this.railValidations.delete(requestId); resolve(result); };
      this.railValidations.set(requestId, { runnerId: runner.runnerId, bootId: runner.bootId, finish });
      try { this.write(runner.stream, { capabilityValidationRequest: request }); }
      catch { finish({ passed: false, message: "Runner disconnected before Rail validation could start.", latencyMs: 0 }); }
    });
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
    // retried on the next one; it must never take the Controller down. Skip
    // ticks while the previous task is pending so a slow database does not
    // accumulate overlapping queries and exhaust the shared connection pool.
    const every = (label: string, ms: number, task: () => Promise<unknown> | undefined) => {
      let running = false;
      return setInterval(() => {
        if (running || this.stopping) return;
        running = true;
        void this.pending.track(Promise.resolve().then(task)
          .catch(error => logDatabaseFailure("controller.background_error", error, this.service.databasePoolState?.() ?? null, { operation: label }))
          .finally(() => { running = false; }));
      }, ms);
    };
    this.timers = [
      every("Validation dispatch", 1_000, () => this.dispatchValidationRequests()),
      every("Desired state dispatch", 1_000, () => this.dispatchDesiredStateChanges()),
      every("Artifact environment checks", 5_000, () => this.connections.size ? this.service.packages?.checkPendingEnvironments?.() : undefined),
      every("Runner reconciliation", 30_000, () => this.reconcileAll()),
      every("Traffic expiry", 30_000, () => this.service.trafficRouting?.expireCalls()),
      every("Stale Runner sweep", this.config.offlineAfterSeconds * 1_000, () => this.service.markStaleRunnersOffline()),
    ];
    for (const timer of this.timers) timer.unref();
  }

  async stop(): Promise<void> {
    if (this.stopJob) return this.stopJob;
    this.stopping = true;
    for (const compilation of this.compilations.values()) compilation.finish(undefined, "Controller stopped during compilation. Retry publication.");
    for (const validation of this.railValidations.values()) validation.finish({ passed: false, message: "Controller stopped during Rail validation.", latencyMs: 0 });
    for (const [requestId, admission] of this.admissions) admission.finish({ poolId: "", runnerId: admission.runnerId, admitted: false, unavailable: true, reason: `Controller stopped during load check ${requestId}.`, nemoVersion: "", modelRevisionId: "" });
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const [stream, disconnect] of this.streams) { stream.end(); disconnect(); }
    this.stopJob = (async () => {
      await new Promise<void>((resolve) => this.grpc.tryShutdown(() => resolve()));
      await this.pending.drain();
    })();
    return this.stopJob;
  }

  forceStop(): void { this.grpc.forceShutdown(); }

  private isTestingRunner(connection: Connection): boolean {
    // Each deployment is its own control-plane boundary. Never fail over tests
    // to another ordinal or pool when its stable StatefulSet ordinal 0 is absent.
    return connection.poolId === "default" && connection.compilerCapable && connection.runnerId.endsWith("-0");
  }

  hasDefaultCompiler(): boolean {
    return !this.stopping && [...this.connections.values()].some(item => this.isTestingRunner(item));
  }

  removeRunnerConnection(runnerId: string, bootId: string): void {
    const connection = this.connections.get(runnerId);
    if (!connection || connection.bootId !== bootId) return;
    this.releaseConnection(connection);
    connection.stream.end();
  }

  private releaseConnection(connection: Connection): void {
    this.connections.delete(connection.runnerId);
    for (const compilation of this.compilations.values()) {
      if (compilation.runnerId === connection.runnerId && compilation.bootId === connection.bootId)
        compilation.finish(undefined, "Runner disconnected during compilation. Retry publication.");
    }
    for (const [runId, owner] of this.activeValidations) {
      if (owner === connection) this.activeValidations.delete(runId);
    }
    this.metrics.controlConnection(connection.poolId, false);
    for (const validation of this.railValidations.values()) {
      if (validation.runnerId === connection.runnerId && validation.bootId === connection.bootId)
        validation.finish({ passed: false, message: "Runner disconnected during Rail validation.", latencyMs: 0 });
    }
  }

  async distributeProtectionModes(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map(connection => {
      let key = this.protectionKeys.get(connection);
      if (!key) { key = {}; this.protectionKeys.set(connection, key); }
      return this.pending.track(this.syncQueue.run(key, async () => {
        if (this.connections.get(connection.runnerId) === connection) await this.reconcileProtectionModes(connection);
      }));
    }));
  }

  private async reconcileProtectionModes(connection: Connection): Promise<void> {
    if (!connection.protectionCapable || !this.service.protectionModes) return;
    const protection = await this.service.protectionModes.desiredState();
    if (this.connections.get(connection.runnerId) !== connection) return;
    if (connection.lastProtectionGeneration < protection.generation) {
      this.write(connection.stream, { protectionState: { generation: String(protection.generation), modes: protection.modes } });
      connection.lastProtectionGeneration = protection.generation;
    }
  }

  async distributeDesiredState(poolId = "default", timeoutMs = 2_500): Promise<{
    desiredGeneration: number;
    distributionStatus: "ready" | "syncing";
  }> {
    const desiredGeneration = await this.service.desiredGeneration();
    const expectedModelRevisionId = (await this.models.activeConfiguration(true))?.revisionId ?? "";
    await this.dispatchDesiredStateChanges();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const runners = [...this.connections.values()].filter((item) => item.poolId === poolId);
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
    const expectedModelRevisionId = (await this.models.activeConfiguration(true))?.revisionId ?? "";
    const runners = [...this.connections.values()].filter((item) => item.poolId === poolId);
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
    if (this.stopping) {
      stream.emit("error", Object.assign(new Error("Controller is stopping"), { code: status.UNAVAILABLE }));
      return;
    }
    const authorization = stream.metadata.get("authorization")[0];
    if (authorization !== `Bearer ${this.config.runnerToken}`) {
      this.metrics.observeControlMessage("received", "authentication", "rejected");
      const error = Object.assign(new Error("Runner authentication failed."), { code: status.UNAUTHENTICATED });
      // grpc-js sends the final gRPC status from its error handler. Destroying
      // the duplex stream here can leave the client waiting until its deadline.
      stream.emit("error", error);
      return;
    }
    let connection: Connection | null = null;
    let closed = false;
    let cleanup: Promise<void> | undefined;
    let messageChain = Promise.resolve();
    stream.on("data", (message: RunnerMessage__Output) => {
      if (this.stopping || closed) return;
      const messageType = message.body ?? "unknown";
      messageChain = this.pending.track(messageChain.then(async () => {
        const registered = await this.handleMessage(stream, message, connection, this.stopping && closed);
        if (registered) connection = registered;
        // The stream can close while registration is awaiting the database.
        if (closed) disconnected();
        this.metrics.observeControlMessage("received", messageType);
      }).catch((error: unknown) => {
        // Registration can install the connection before its first database
        // reconciliation fails; retain that identity for cleanup as well.
        connection ??= [...this.connections.values()].find(item => item.stream === stream) ?? null;
        this.metrics.observeControlMessage("received", messageType, "error");
        logDatabaseFailure("runner.control_error", error, this.service.databasePoolState?.() ?? null, {
          operation: messageType,
          ...(connection ? { runnerId: connection.runnerId, bootId: connection.bootId } : {}),
          ...(message.validationResult ? { runId: message.validationResult.runId } : {}),
          ...(message.validationReport ? { runId: message.validationReport.runId } : {}),
          ...(message.validationProgress ? { runId: message.validationProgress.runId } : {}),
        });
        // grpc status is also logged by the Runner. Never send a Drizzle
        // message there: it includes query parameters and report contents.
        const { category, code } = databaseErrorFields(error);
        const detail = `Runner control request failed (${code ?? category}).`;
        stream.emit("error", Object.assign(new Error(detail), { code: status.INTERNAL }));
      }));
    });
    const disconnected = () => {
      closed = true;
      this.streams.delete(stream);
      if (cleanup) return;
      if (connection && this.connections.get(connection.runnerId) === connection) this.releaseConnection(connection);
      // Apply offline only after accepted heartbeats/results finish; otherwise
      // a queued heartbeat can overwrite the offline transition. Registration
      // itself may still be pending when the transport closes.
      cleanup = this.pending.track(messageChain.then(async () => {
        if (!connection) return;
        const current = this.connections.get(connection.runnerId);
        if (current && current !== connection) return;
        if (current === connection) this.releaseConnection(connection);
        await this.service.disconnectRunner(connection.runnerId, connection.bootId);
      }).catch(error => {
        logDatabaseFailure("runner.disconnect_error", error, this.service.databasePoolState?.() ?? null,
          connection ? { runnerId: connection.runnerId, bootId: connection.bootId } : {});
      }));
    };
    this.streams.set(stream, disconnected);
    stream.once("end", disconnected);
    stream.once("close", disconnected);
    stream.once("error", disconnected);
  }

  private async handleMessage(
    stream: RunnerStream,
    message: RunnerMessage__Output,
    current: Connection | null,
    draining = false,
  ): Promise<Connection | null> {
    if (message.registration) {
      if (current) throw new Error("Runner registered more than once on one stream.");
      const registration = message.registration;
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
      });
      const connection: Connection = {
        stream,
        runnerId: registration.runnerId,
        bootId: registration.bootId,
        poolId: registration.poolId,
        compilerCapable: registration.compilerCapable,
        appliedGeneration: number(registration.appliedGeneration),
        offlineCompilation: registration.labels?.[OFFLINE_COMPILATION_CAPABILITY] === "1",
        appliedModelRevisionId: "",
        lastReconcileGeneration: -1,
        protectionCapable: registration.labels?.[PROTECTION_MODE_CAPABILITY] === "1",
        appliedProtectionGeneration: number(registration.appliedProtectionGeneration),
        lastProtectionGeneration: -1,
      };
      const prior = this.connections.get(connection.runnerId);
      if (prior) this.releaseConnection(prior);
      this.connections.set(connection.runnerId, connection);
      this.metrics.controlConnection(connection.poolId, true);
      this.write(stream, {
        registrationAccepted: {
          desiredGeneration: String(desiredGeneration),
          heartbeatIntervalSeconds: this.config.heartbeatIntervalSeconds,
          validationReportGzip: true,
        },
      });
      await this.reconcile(connection);
      return connection;
    }
    if (!current) throw new Error("Runner must register before sending control messages.");
    const registered = this.connections.get(current.runnerId);
    // stop() removes live routing immediately, but messages accepted before
    // admission closed (especially queued reports) must still persist. Never
    // let an old stream act on a replacement connection's registration.
    if (registered !== current && (!draining || registered)) return null;
    if (message.heartbeat) {
      const heartbeat = message.heartbeat;
      if (heartbeat.runnerId !== current.runnerId || heartbeat.bootId !== current.bootId) {
        throw new Error("Heartbeat identity does not match the registered stream.");
      }
      try {
        const accepted = await this.service.recordHeartbeat({
          runnerId: heartbeat.runnerId,
          bootId: heartbeat.bootId,
          sequence: number(heartbeat.sequence),
          appliedGeneration: number(heartbeat.appliedGeneration),
          load: normalizeLoad(heartbeat.load),
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
      if (progress.runnerId !== current.runnerId || !this.isTestingRunner(current)) {
        throw new Error("Validation progress identity does not match a registered compiler stream.");
      }
      const phase = {
        VALIDATION_EXECUTION_PHASE_PREPARING: "preparing",
        VALIDATION_EXECUTION_PHASE_EXECUTING: "executing",
        VALIDATION_EXECUTION_PHASE_FINALIZING: "finalizing",
      } as const;
      if (progress.phase === "VALIDATION_EXECUTION_PHASE_UNSPECIFIED") return current;
      await this.service.updateValidationProgress(progress.runId, {
        phase: phase[progress.phase], completedCases: progress.completedCases, passedCases: progress.passedCases,
      });
    } else if (message.validationResult || message.validationReport) {
      const started = performance.now();
      const result = message.validationReport ? await this.decodeValidationReport(message.validationReport) : message.validationResult!;
      if (result.runnerId !== current.runnerId) throw new Error("Validation result identity does not match the registered stream.");
      this.metrics.observeJob("validation", result.accepted);
      const owner = this.activeValidations.get(result.runId);
      if (owner && owner !== current) throw new Error("Validation result belongs to another Runner stream.");
      if (!this.isTestingRunner(current)) throw new Error("Validation result is not from the ordinal-0 testing Runner.");
      if (result.status === "VALIDATION_STATUS_CANCELLED") {
        await this.service.markOutboxProcessed(`cancel-${result.runId}`);
      } else {
        await this.handleValidationResult(result);
      }
      this.activeValidations.delete(result.runId);
      this.write(current.stream, { validationReportAck: { runId: result.runId } });
      console.info(JSON.stringify({ event: "validation.report_saved", run_id: result.runId, runner_id: current.runnerId,
        cases: result.results?.length ?? 0, duration_ms: Math.round(performance.now() - started) }));
    } else if (message.artifactCompilationResult) {
      const result = message.artifactCompilationResult;
      const pending = this.compilations.get(result.compileId);
      if (pending && result.runnerId === current.runnerId && pending.runnerId === current.runnerId && pending.bootId === current.bootId) {
        pending.finish(result.artifact ? artifactFromWire(result.artifact) as ArtifactContent : undefined, result.error);
      }
    } else if (message.artifactAdmissionResult) {
      const result = message.artifactAdmissionResult;
      const pending = this.admissions.get(result.requestId);
      if (pending && pending.runnerId === current.runnerId && pending.bootId === current.bootId) {
        pending.finish({ poolId: current.poolId, runnerId: current.runnerId, admitted: result.admitted, unavailable: false,
          reason: result.reason, nemoVersion: result.nemoVersion, modelRevisionId: result.modelRevisionId });
      }
    } else if (message.capabilityValidationResult) {
      const result = message.capabilityValidationResult;
      const pending = this.railValidations.get(result.requestId);
      if (pending && pending.runnerId === current.runnerId && pending.bootId === current.bootId) {
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
    } else if (message.desiredStateResult) {
      const result = message.desiredStateResult;
      if (result.runnerId !== current.runnerId) {
        throw new Error("Desired-state result identity does not match the registered stream.");
      }
      const generation = number(result.generation);
      if (result.accepted) {
        if (generation < current.appliedGeneration) return null;
        current.appliedGeneration = Math.max(current.appliedGeneration, generation);
        current.appliedModelRevisionId = result.modelRevisionId;
        if (result.modelRevisionId) {
          const peers = [...this.connections.values()].filter((item) => item.poolId === current.poolId);
          if (peers.length > 0 && peers.every((item) => (
            item.appliedGeneration >= generation
            && item.appliedModelRevisionId === result.modelRevisionId
          ))) {
            await this.models.finalizeActivation(result.modelRevisionId);
          }
        }
      } else {
        await this.service.trafficRouting?.reportRolloutFailure?.(
          generation, current.runnerId,
          result.reason || `Runner ${current.runnerId} rejected desired generation ${generation}.`,
        );
        if (result.modelRevisionId) {
          await this.models.failActivation(
            result.modelRevisionId,
            result.reason || `Runner ${current.runnerId} rejected desired generation ${generation}.`,
          );
        }
        for (const connection of this.connections.values()) connection.lastReconcileGeneration = -1;
        await this.reconcileAll();
      }
    }
    return null;
  }

  private async decodeValidationReport(report: NonNullable<RunnerMessage__Output["validationReport"]>): Promise<ValidationResult__Output> {
    const size = Number(report.rawSizeBytes);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_REPORT_BYTES) throw new Error("Validation report exceeds the decoded size budget.");
    const bytes = await decompressReport(report.gzipResult, { maxOutputLength: MAX_REPORT_BYTES });
    if (bytes.length !== size || createHash("sha256").update(bytes).digest("hex") !== report.sha256)
      throw new Error("Validation report size or digest does not match.");
    const result = this.validationResultCodec.deserialize(bytes);
    if (result.runnerId !== report.runnerId || result.runId !== report.runId)
      throw new Error("Validation report identity does not match its envelope.");
    return result;
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

  private async reconcileAll(): Promise<boolean> {
    const results = await Promise.allSettled([...this.connections.values()].map((connection) => this.reconcile(connection)));
    return results.every(result => result.status === "fulfilled");
  }

  private async reconcile(connection: Connection): Promise<void> {
    return this.pending.track(this.syncQueue.run(connection, async () => {
      if (this.connections.get(connection.runnerId) === connection) await this.reconcileOnce(connection);
    }));
  }

  private async reconcileOnce(connection: Connection): Promise<void> {
    const started = performance.now();
    try {
      // Send the operating overlay before materializing any model/Artifact state.
      // Old Runners cannot ACK this message and remain visibly unsupported.
      await this.reconcileProtectionModes(connection);
      const results = await Promise.allSettled([
        this.service.desiredStateForPool(connection.poolId),
        this.models.activeConfiguration(true),
      ]);
      // Keep the queue slot until both reads settle, including during an outage.
      if (results[0].status === "rejected") throw results[0].reason;
      if (results[1].status === "rejected") throw results[1].reason;
      const desiredUnknown = results[0].value, modelConfiguration = results[1].value;
      if (this.connections.get(connection.runnerId) !== connection) return;
      // The transaction wrapper intentionally exposes an opaque result type in
      // the database adapter. Keep the wire projection typed at this boundary.
      const desired = desiredUnknown as Awaited<ReturnType<ControlPlaneService["desiredStateForPool"]>> & {
        routerRevisions?: Array<any>;
        endpoints: Array<any>;
      };
      if (connection.lastReconcileGeneration === desired.generation) {
        this.metrics.observeReconcile(connection.poolId, "noop", (performance.now() - started) / 1_000);
        return;
      }
      const unsupported = desired.artifacts.map(artifact => ({ id: artifact.id, reason: artifactExecutionContractIssue(artifact) }))
        .find(item => item.reason);
      if (unsupported) {
        await this.service.trafficRouting?.reportRolloutFailure?.(desired.generation, connection.runnerId,
          `Artifact ${unsupported.id}: ${unsupported.reason}`);
        this.metrics.observeReconcile(connection.poolId, "unsupported", (performance.now() - started) / 1_000);
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
      this.write(connection.stream, {
      desiredState: {
        generation: String(desired.generation),
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
      });
      connection.lastReconcileGeneration = desired.generation;
      this.metrics.observeReconcile(connection.poolId, "dispatched", (performance.now() - started) / 1_000);
    } catch (error) {
      this.metrics.observeReconcile(connection.poolId, "error", (performance.now() - started) / 1_000);
      logDatabaseFailure("runner.reconcile_error", error, this.service.databasePoolState?.() ?? null,
        { runnerId: connection.runnerId, bootId: connection.bootId });
      throw error;
    }
  }

  private async dispatchValidationRequests(): Promise<void> {
    // Timer ticks may overlap while PostgreSQL is slow. Reserve a single job per
    // compiler until its result is committed or the stream disconnects.
    if (this.dispatchingValidation) return;
    this.dispatchingValidation = true;
    try {
      // Deliver stops before checking busy/model state. Intent survives Controller
      // restart and is retried until the Runner acknowledges cleanup.
      const primary = [...this.connections.values()].find(item => this.isTestingRunner(item));
      if (!primary) return;
      const cancellations = await this.service.pendingOutbox("guardrail.validation_cancel_requested", 100);
      for (const event of cancellations) {
        this.write(primary.stream, { validationCancelRequest: { runId: string(event.payload.runId) } });
      }
      if (cancellations.length) return;
      const expectedModelRevisionId = (await this.models.activeConfiguration(true))?.revisionId ?? "";
      const busy = new Set(this.activeValidations.values());
      // Capability probes use an explicit candidate configuration. Guardrail
      // tests use the Runner's live providers and must wait for their ACK.
      const compiler = this.isTestingRunner(primary) && primary.appliedModelRevisionId === expectedModelRevisionId
        && !busy.has(primary) ? primary : undefined;
      if (!compiler) return;
      const excludedRunIds = [...this.activeValidations.keys()];
      const events = [
        ...await this.service.pendingOutbox("guardrail.validation_requested", 1, excludedRunIds),
        ...await this.service.pendingOutbox("policy.validation_requested", 1, excludedRunIds),
      ].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
      const event = events.find(item => !this.activeValidations.has(string(item.payload.runId)));
      if (!event) return;
      const payload = event.payload;
      const runId = string(payload.runId);
      this.activeValidations.set(runId, compiler);
      try {
        if (await this.service.markValidationRunning(event.id) === false) {
          this.activeValidations.delete(runId);
          return;
        }
        await this.service.deferOutbox(event.id, 30);
        if (this.connections.get(compiler.runnerId) !== compiler) {
          this.activeValidations.delete(runId);
          return;
        }
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
    // allSettled lets healthy Runners progress, but failed DB reads are not a
    // successful dispatch. Preserve the durable event for the next tick.
    if (!await this.reconcileAll()) return;
    for (const event of events) await this.service.markOutboxProcessed(event.id);
  }

  private write(stream: RunnerStream, body: ControllerBody): void {
    if (stream.writableEnded || stream.destroyed) return;
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
    "registrationAccepted", "desiredState", "protectionState", "validationRequest", "validationCancelRequest", "validationReportAck", "drainRequest",
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
