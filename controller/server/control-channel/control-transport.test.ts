import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { credentials, loadPackageDefinition, Metadata, Server, ServerCredentials, status } from "@grpc/grpc-js";
import { loadSync, type MessageTypeDefinition } from "@grpc/proto-loader";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../config.js";
import type { ProtoGrpcType } from "../generated/control-protocol/runner_control.js";
import type { ValidationResult } from "../generated/control-protocol/tasklattice/guard/control/v1/ValidationResult.js";
import type { ControllerMetrics } from "../metrics.js";
import type { ModelConfigurationService } from "../model-config/service.js";
import type { ControlPlaneService } from "../services/control-plane.js";
import { RunnerControlServer } from "./control-server.js";
import { CONTROL_MESSAGE_MAX_BYTES, controlChannelOptions } from "./transport.js";

const config = loadConfig({
  NODE_ENV: "production",
  CONTROLLER_GRPC_TRANSPORT: "plaintext",
  CONTROLLER_METRICS_TOKEN: "metrics-token-that-is-at-least-32-characters",
  CONTROLLER_DATABASE_URL: "postgresql://controller:controller@localhost/controller",
  CONTROLLER_RUNNER_TOKEN: "runner-token-that-is-at-least-32-characters",
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: "/tmp/controller-signing-key.pem",
  CONTROLLER_PROTO_PATH: resolve("../proto/tasklattice/guard/control/v1/runner_control.proto"),
  BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-32-characters",
});

describe("production Controller gRPC transport budget", () => {
  it.each([undefined, "Bearer wrong-token"])("rejects unauthenticated plaintext connections (%s)", async (authorization) => {
    const service = { registerRunner: vi.fn() };
    const metrics = { observeControlMessage: vi.fn() };
    const server = new RunnerControlServer(config, service as unknown as ControlPlaneService,
      metrics as unknown as ControllerMetrics,
      {} as ModelConfigurationService);
    const grpcServer = (server as unknown as { grpc: Server }).grpc;
    const port = await new Promise<number>((resolvePort, reject) => {
      grpcServer.bindAsync("127.0.0.1:0", (server as unknown as { credentials: () => ServerCredentials }).credentials(), (error, value) => {
        if (error) reject(error); else resolvePort(value);
      });
    });
    const descriptor = loadPackageDefinition(loadSync(config.protoPath, {
      includeDirs: [dirname(config.protoPath)], longs: String, enums: String, defaults: true, oneofs: true,
    })) as unknown as ProtoGrpcType;
    const client = new descriptor.tasklattice.guard.control.v1.RunnerControl(
      `127.0.0.1:${port}`, credentials.createInsecure(), controlChannelOptions,
    );
    const metadata = new Metadata();
    if (authorization) metadata.set("authorization", authorization);
    const stream = client.Connect(metadata, { deadline: Date.now() + 2_000 });
    try {
      const error = new Promise<{ code: number; details: string }>((resolveError) => stream.once("error", resolveError));
      stream.write({ registration: { runnerId: "unauthorized", bootId: "boot", poolId: "default" } });
      await expect(error).resolves.toMatchObject({ code: status.UNAUTHENTICATED, details: "Runner authentication failed." });
      expect(service.registerRunner).not.toHaveBeenCalled();
    } finally {
      stream.cancel();
      client.close();
      grpcServer.forceShutdown();
    }
  });

  it("rejects chunks with invalid identity, size or digest before persistence",async()=>{
    const service={reportResults:{stage:vi.fn().mockResolvedValue(true)},completeValidation:vi.fn()};
    const server=new RunnerControlServer(config,service as unknown as ControlPlaneService,{observeControlMessage:vi.fn()} as unknown as ControllerMetrics,{} as ModelConfigurationService);
    const internal=server as unknown as {connections:Map<string,unknown>;handleMessage(stream:unknown,message:unknown,current:unknown):Promise<unknown>};
    const stream={write:vi.fn()},current={runnerId:"runner-0",bootId:"boot",poolId:"default",compilerCapable:true,stream};
    internal.connections.set(current.runnerId,current);
    const definition=loadSync(config.protoPath,{longs:String,enums:String,defaults:true,oneofs:true});
    const codec=definition["tasklattice.guard.control.v1.ValidationResult"] as MessageTypeDefinition<ValidationResult,unknown>;
    const bytes=codec.serialize({runnerId:"runner-0",runId:"report",accepted:true,status:"VALIDATION_STATUS_PASSED",metrics:{total:0}});
    const digest=createHash("sha256").update(bytes).digest("hex");
    const valid={runnerId:"runner-0",runId:"report",uploadId:"fixture",sequence:0,chunks:1,cases:0,caseOffset:0,final:true,
      manifestDigest:createHash("sha256").update(digest).digest("hex"),gzipResult:gzipSync(bytes),rawSizeBytes:bytes.length,sha256:digest};
    const handle=(part:unknown)=>internal.handleMessage(stream,{validationReportChunk:part},current);
    try {
      await handle(valid);expect(service.completeValidation).toHaveBeenCalledOnce();
      await expect(handle({...valid,sha256:"bad"})).rejects.toThrow("digest");
      await expect(handle({...valid,runId:"other"})).rejects.toThrow("identity");
      await expect(handle({...valid,rawSizeBytes:9*1024*1024})).rejects.toThrow("size budget");
      expect(service.reportResults.stage).toHaveBeenCalledOnce();
    } finally {internal.connections.clear();await server.stop();}
  });

  it.each([false,true])("preserves bounded chunks and enforces the wire ceiling (oversized=%s)",async oversized=>{
    const evidence="synthetic evidence ".repeat(2200),count=950,received:Array<{caseId:string;outputContent:string}>=[];
    const desiredId="disabled-"+"d".repeat(5*1024*1024);
    const service={registerRunner:vi.fn().mockResolvedValue(1),disconnectRunner:vi.fn(),completeValidation:vi.fn(),
      reportResults:{stage:vi.fn(async(chunk:{results:typeof received;final:boolean})=>{received.push(...chunk.results);return chunk.final;})},
      desiredStateForPool:vi.fn().mockResolvedValue({generation:1,artifacts:[],routers:[],endpoints:[],disabledGuardrailIds:[desiredId],disabledEndpointIds:[],guardrailLoggingLevels:{}})};
    const metrics={observeControlMessage:vi.fn(),controlConnection:vi.fn(),observeReconcile:vi.fn(),observeJob:vi.fn()};
    const server=new RunnerControlServer(config,service as unknown as ControlPlaneService,metrics as unknown as ControllerMetrics,{activeConfiguration:vi.fn().mockResolvedValue(null)} as unknown as ModelConfigurationService);
    const grpcServer=(server as unknown as {grpc:Server}).grpc;
    const port=await new Promise<number>((resolvePort,reject)=>grpcServer.bindAsync("127.0.0.1:0",(server as unknown as {credentials:()=>ServerCredentials}).credentials(),(error,value)=>error?reject(error):resolvePort(value)));
    const definition=loadSync(config.protoPath,{longs:String,enums:String,defaults:true,oneofs:true}),descriptor=loadPackageDefinition(definition) as unknown as ProtoGrpcType;
    const client=new descriptor.tasklattice.guard.control.v1.RunnerControl(`127.0.0.1:${port}`,credentials.createInsecure(),{...controlChannelOptions,"grpc.max_send_message_length":CONTROL_MESSAGE_MAX_BYTES+1024*1024});
    const metadata=new Metadata();metadata.set("authorization",`Bearer ${config.runnerToken}`);
    const stream=client.Connect(metadata,{deadline:Date.now()+15000});
    let desired:string|undefined,errorCode:number|undefined,savedRun:string|undefined;
    const acks=new Map<number,()=>void>();
    stream.on("error",(error:{code:number})=>{errorCode=error.code;});
    stream.on("data",message=>{if(message.desiredState)desired=message.desiredState.disabledGuardrailIds[0];if(message.validationReportChunkAck)acks.get(message.validationReportChunkAck.sequence)?.();if(message.validationReportAck)savedRun=message.validationReportAck.runId;});
    try {
      stream.write({registration:{runnerId:"transport-runner-0",bootId:"boot-1",poolId:"default",compilerCapable:true}});
      await expect.poll(()=>desired).toBe(desiredId);
      if(oversized){
        stream.write({validationReportChunk:{runnerId:"transport-runner-0",runId:"large-validation",gzipResult:Buffer.alloc(CONTROL_MESSAGE_MAX_BYTES),rawSizeBytes:1}});
        await expect.poll(()=>errorCode).toBe(status.RESOURCE_EXHAUSTED);expect(service.completeValidation).not.toHaveBeenCalled();
      } else {
        const codec=definition["tasklattice.guard.control.v1.ValidationResult"] as MessageTypeDefinition<ValidationResult,unknown>;
        const parts:Buffer[]=[];
        for(let offset=0;offset<count;offset+=20)parts.push(codec.serialize({runnerId:"transport-runner-0",runId:"large-validation",results:Array.from({length:Math.min(20,count-offset)},(_,i)=>({caseId:`case-${offset+i}`,passed:true,outputContent:evidence,action:"ENFORCEMENT_ACTION_ALLOW",actualDecision:"VALIDATION_DECISION_ALLOW"}))}));
        parts.push(codec.serialize({runnerId:"transport-runner-0",runId:"large-validation",accepted:true,status:"VALIDATION_STATUS_PASSED",metrics:{total:count,passed:count}}));
        expect(parts.reduce((sum,b)=>sum+b.length,0)).toBeGreaterThan(CONTROL_MESSAGE_MAX_BYTES);
        const hashes=parts.map(b=>createHash("sha256").update(b).digest("hex")),manifest=createHash("sha256").update(hashes.join("\n")).digest("hex");
        for(const [sequence,bytes] of parts.entries()){
          expect(bytes.length).toBeLessThan(1024*1024);
          const ack=new Promise<void>(resolveAck=>acks.set(sequence,resolveAck));
          stream.write({validationReportChunk:{runnerId:"transport-runner-0",runId:"large-validation",uploadId:"fixture",sequence,chunks:parts.length,cases:count,caseOffset:Math.min(sequence*20,count),final:sequence===parts.length-1,manifestDigest:manifest,gzipResult:gzipSync(bytes),rawSizeBytes:bytes.length,sha256:hashes[sequence]}});
          await ack;
        }
        await expect.poll(()=>savedRun).toBe("large-validation");
        expect(received).toHaveLength(count);expect(received.at(-1)?.outputContent).toBe(evidence);
        expect(service.completeValidation.mock.calls[0][0]).toMatchObject({upload:{runnerBootId:"boot-1",uploadId:"fixture"}});
        expect(service.completeValidation.mock.calls[0][0]).not.toHaveProperty("results");expect(errorCode).toBeUndefined();
      }
    } finally {stream.cancel();client.close();await server.stop();}
  },20000);

});

describe("Controller background work", () => {
  it("does not pile up periodic database work while a previous tick is pending, and retries after failure", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending = Promise.withResolvers<[]>();
    const failure = new Error("timeout exceeded when trying to connect");
    const service = {
      pendingOutbox: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([]),
      markStaleRunnersOffline: vi.fn().mockResolvedValue(undefined),
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new RunnerControlServer({ ...config, grpc: { host: "127.0.0.1", port: 0 } }, service as unknown as ControlPlaneService,
      { observeControlMessage: vi.fn() } as unknown as ControllerMetrics, {} as ModelConfigurationService);
    try {
      await server.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(service.pendingOutbox).toHaveBeenCalledTimes(1);
      pending.reject(failure);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('"operation":"Desired state dispatch"'));
      expect(service.pendingOutbox).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(service.pendingOutbox).toHaveBeenCalledTimes(3);
    } finally {
      pending.resolve([]);
      await server.stop();
      logged.mockRestore();
      vi.useRealTimers();
    }
  });

  it("logs a failed periodic tick and keeps running instead of crashing the process", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const failure = new Error("Connection terminated due to connection timeout");
    const service = { pendingOutbox: vi.fn().mockRejectedValue(failure), markStaleRunnersOffline: vi.fn().mockResolvedValue(undefined) };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = new RunnerControlServer({ ...config, grpc: { host: "127.0.0.1", port: 0 } }, service as unknown as ControlPlaneService,
      { observeControlMessage: vi.fn() } as unknown as ControllerMetrics, {} as ModelConfigurationService);
    try {
      await server.start();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('"operation":"Desired state dispatch"'));
      // The next tick runs again.
      expect(service.pendingOutbox.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.stop();
      logged.mockRestore();
      vi.useRealTimers();
    }
  });
});
