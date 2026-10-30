import { z } from "zod";

import { usernameSchema } from "../shared/username.js";
import { clusterBootstrapEnvironment } from "./cluster-bootstrap.js";

const modelRuntime = z.object({
  id: z.string().trim().min(1),
  client: z.literal("openai_chat").default("openai_chat"),
  base_url: z.string().url(),
  model: z.string().trim().min(1),
  api_key_env_var: z.string().trim().min(1).optional(),
  timeout_seconds: z.number().positive().default(20),
  max_tokens: z.number().int().positive().default(128),
});

const modelRuntimeList = z.array(modelRuntime).superRefine((items, context) => {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Model Runtime IDs must be unique." });
  }
});

const evaluatorProfiles = {
  "tali.qwen3guard.v1": new Set([
    "tali.guard.content-safety.v1",
    "tali.guard.jailbreak.v1",
    "tali.guard.pii.semantic.v1",
  ]),
  "tali.llama-guard-3.v1": new Set(["tali.guard.content-safety.v1"]),
  "tali.taxonomy-judge.v1": new Set([
    "tali.guard.taxonomy-normalization.v1",
    "tali.guard.topic-control.semantic.v1",
  ]),
} as const;

const evaluatorBindingList = z.array(z.object({
  id: z.string().trim().min(1),
  contract_ref: z.string().trim().min(1),
  profile_ref: z.enum([
    "tali.qwen3guard.v1",
    "tali.llama-guard-3.v1",
    "tali.taxonomy-judge.v1",
  ]),
  model_ref: z.string().trim().min(1),
  priority: z.number().int().default(100),
})).superRefine((items, context) => {
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Evaluator Binding IDs must be unique." });
  }
  const routes = items.map((item) => `${item.contract_ref}\u0000${item.priority}`);
  if (new Set(routes).size !== routes.length) {
    context.addIssue({ code: "custom", message: "Evaluator Binding contract priorities must be unique." });
  }
  for (const [index, item] of items.entries()) {
    if (!evaluatorProfiles[item.profile_ref].has(item.contract_ref)) {
      context.addIssue({
        code: "custom",
        path: [index, "contract_ref"],
        message: `Evaluator Profile ${item.profile_ref} does not implement ${item.contract_ref}.`,
      });
    }
  }
});

function parseConfiguration<T>(value: string, name: string, schema: z.ZodType<T>): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
  return schema.parse(decoded);
}

function parseLegacyConfiguration<T>(value: string, name: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    return parseConfiguration(value, name, schema);
  } catch (error) {
    process.stderr.write(
      `Ignoring invalid legacy ${name}; configure Models in Controller Settings instead: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    return fallback;
  }
}

function isCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split("/");
  if (!address || !prefix || rest.length) return false;
  const bits = Number(prefix);
  if (!Number.isInteger(bits)) return false;
  if (z.ipv4().safeParse(address).success) return bits >= 0 && bits <= 32;
  if (z.ipv6().safeParse(address).success) return bits >= 0 && bits <= 128;
  return false;
}

function httpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CONTROLLER_HTTP_HOST: z.string().default("0.0.0.0"),
  CONTROLLER_HTTP_PORT: z.coerce.number().int().positive().default(8080),
  CONTROLLER_GRPC_HOST: z.string().default("0.0.0.0"),
  CONTROLLER_GRPC_PORT: z.coerce.number().int().positive().default(9090),
  CONTROLLER_GRPC_TRANSPORT: z.enum(["mtls", "plaintext"]).optional(),
  CONTROLLER_GRPC_TLS_CERT_PATH: z.string().optional(),
  CONTROLLER_GRPC_TLS_KEY_PATH: z.string().optional(),
  CONTROLLER_GRPC_TLS_CLIENT_CA_PATH: z.string().optional(),
  CONTROLLER_DATABASE_URL: z.string().url(),
  CONTROLLER_DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1).max(2_147_483_647).default(30_000),
  CONTROLLER_DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(1).max(2_147_483_647).default(5_000),
  CONTROLLER_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().min(1).max(2_147_483_647).default(30_000),
  CONTROLLER_RUNNER_SYNC_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
  CONTROLLER_PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  CONTROLLER_RUNTIME_SERVICE_URL: z.string().url().default("http://localhost:8091"),
  // Advertised Endpoint address only; Controller-to-Runner calls use the Service URL.
  CONTROLLER_RUNTIME_PUBLIC_URL: z.string().trim().default("").refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return /^https?:\/\//.test(value) && !url.username && !url.password && !/[?#\s]/.test(value);
    } catch {
      return false;
    }
  }, "Expected an HTTP(S) base URL without credentials, query, or fragment, or an empty value."),
  CONTROLLER_UI_DIST: z.string().default("dist"),
  CONTROLLER_POLICY_CATALOG_DIR: z
    .string()
    .min(1)
    .default("../runner/toolkit/policy_library/assets"),
  CONTROLLER_PROTO_PATH: z
    .string()
    .default("../proto/tasklattice/guard/control/v1/runner_control.proto"),
  CONTROLLER_MIGRATIONS_PATH: z.string().default("server/db/migrations"),
  CONTROLLER_RUNNER_TOKEN: z.string().min(32),
  CONTROLLER_METRICS_TOKEN: z.string().min(32).optional(),
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().default("http://localhost:8080,http://localhost:8092"),
  // CIDRs of proxies allowed to supply X-Forwarded-For. Empty means the socket
  // peer is authoritative and any supplied chain is ignored (not trusted).
  CONTROLLER_TRUSTED_PROXY_CIDRS: z.string().default("").refine(
    (value) => value.split(",").map((item) => item.trim()).filter(Boolean).every(isCidr),
    "Expected comma-separated IPv4/IPv6 CIDRs, for example 10.0.0.0/8,fd00::/8.",
  ),
  BETTER_AUTH_MIN_PASSWORD_LENGTH: z.coerce.number().int().min(8).max(128).default(8),
  CONTROLLER_BOOTSTRAP_ADMIN_USERNAME: usernameSchema.optional(),
  CONTROLLER_BOOTSTRAP_ADMIN_REVISION: z.string().optional(),
  CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(1).max(128).optional(),
  CONTROLLER_BOOTSTRAP_ADMIN_NAME: z.string().min(1).default("Administrator"),
  CONTROLLER_BOOTSTRAP_USER_USERNAME: usernameSchema.optional(),
  CONTROLLER_BOOTSTRAP_USER_REVISION: z.string().optional(),
  CONTROLLER_BOOTSTRAP_USER_PASSWORD: z.string().min(1).max(128).optional(),
  CONTROLLER_BOOTSTRAP_USER_NAME: z.string().min(1).default("User"),
  MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL: z.string().trim().optional(),
  MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL: z.string().min(1).optional(),
  MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY: z.string().min(1).optional(),
  MODEL_GUARDRAILS_CONTROL_PLANE_AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(45_000),
  MODEL_GUARDRAILS_PLAYGROUND_CHAT_BASE_URL: z.string().trim().optional(),
  MODEL_GUARDRAILS_PLAYGROUND_CHAT_MODEL: z.string().min(1).optional(),
  MODEL_GUARDRAILS_PLAYGROUND_CHAT_API_KEY: z.string().min(1).optional(),
  MODEL_GUARDRAILS_RUNTIME_LOG_ENCRYPTION_KEY: z.string().trim().min(1).optional(),
  RUNNER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(60).default(10),
  RUNNER_OFFLINE_AFTER_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  DELETE_TRAFFIC_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  TELEMETRY_STALE_AFTER_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  MODEL_GUARDRAILS_CONTROL_PLANE_AI_PROVIDER: z.string().trim().min(1).default("Qwen"),
  MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON: z.string().default("[]"),
  MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON: z.string().default("[]"),
  MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL: z.string().trim().optional(),
}).superRefine((value, context) => {
  const tlsPaths = [value.CONTROLLER_GRPC_TLS_CERT_PATH, value.CONTROLLER_GRPC_TLS_KEY_PATH, value.CONTROLLER_GRPC_TLS_CLIENT_CA_PATH];
  if (tlsPaths.some(Boolean) && !tlsPaths.every(Boolean)) {
    context.addIssue({ code: "custom", message: "Controller gRPC TLS certificate, key, and client CA must be configured together." });
  }
  if (value.CONTROLLER_GRPC_TRANSPORT === "plaintext" && tlsPaths.some(Boolean)) {
    context.addIssue({ code: "custom", message: "Plaintext gRPC cannot be combined with TLS certificate paths." });
  }
  if (value.NODE_ENV === "production" && !value.CONTROLLER_METRICS_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["CONTROLLER_METRICS_TOKEN"],
      message: "CONTROLLER_METRICS_TOKEN is required in production.",
    });
  }

  for (const role of ["ADMIN", "USER"] as const) {
    const username = value[`CONTROLLER_BOOTSTRAP_${role}_USERNAME`];
    const password = value[`CONTROLLER_BOOTSTRAP_${role}_PASSWORD`];
    if (Boolean(username) !== Boolean(password)) {
      context.addIssue({ code: "custom", message: `Bootstrap ${role.toLowerCase()} requires both username and password.` });
    }
    if (password && password.length < value.BETTER_AUTH_MIN_PASSWORD_LENGTH) {
      context.addIssue({ code: "custom", path: [`CONTROLLER_BOOTSTRAP_${role}_PASSWORD`],
        message: `Bootstrap password must contain at least ${value.BETTER_AUTH_MIN_PASSWORD_LENGTH} characters.` });
    }
  }
  if (value.CONTROLLER_BOOTSTRAP_USER_USERNAME && value.CONTROLLER_BOOTSTRAP_USER_USERNAME === value.CONTROLLER_BOOTSTRAP_ADMIN_USERNAME) {
    context.addIssue({ code: "custom", message: "Bootstrap admin and user must have different usernames." });
  }
});

export type ControllerConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  environment = clusterBootstrapEnvironment(environment);
  const parsed = environmentSchema.parse(environment);
  const modelRuntimes = parseLegacyConfiguration(
    parsed.MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON,
    "MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON",
    modelRuntimeList,
    [],
  );
  const parsedEvaluatorBindings = parseLegacyConfiguration(
    parsed.MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON,
    "MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON",
    evaluatorBindingList,
    [],
  );
  const modelRuntimeIds = new Set(modelRuntimes.map((item) => item.id));
  const unknownRuntimeBindings = parsedEvaluatorBindings.filter((item) => !modelRuntimeIds.has(item.model_ref));
  if (unknownRuntimeBindings.length) {
    process.stderr.write(`Ignoring legacy Evaluator Bindings that reference unknown Model Runtimes: ${unknownRuntimeBindings.map((item) => item.model_ref).join(", ")}. Configure Models in Controller Settings instead.\n`);
  }
  const controlPlaneBaseUrl = httpUrl(parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL);
  const playgroundBaseUrl = httpUrl(parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_BASE_URL);
  const automatedReasoningUrl = httpUrl(parsed.MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL);
  const controlPlaneAi = controlPlaneBaseUrl
    && parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL
    && parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY
    ? {
        provider: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_PROVIDER,
        baseUrl: controlPlaneBaseUrl,
        model: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL,
        apiKey: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY,
        timeoutMs: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_TIMEOUT_MS,
      }
    : null;
  const playgroundChat = playgroundBaseUrl
    && parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_MODEL
    && parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_API_KEY
    ? {
        provider: "OpenAI-compatible",
        baseUrl: playgroundBaseUrl,
        model: parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_MODEL,
        apiKey: parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_API_KEY,
        timeoutMs: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_TIMEOUT_MS,
      }
    : controlPlaneAi;
  return {
    nodeEnv: parsed.NODE_ENV,
    http: { host: parsed.CONTROLLER_HTTP_HOST, port: parsed.CONTROLLER_HTTP_PORT },
    grpc: { host: parsed.CONTROLLER_GRPC_HOST, port: parsed.CONTROLLER_GRPC_PORT },
    grpcTransport: parsed.CONTROLLER_GRPC_TRANSPORT ?? (parsed.CONTROLLER_GRPC_TLS_CERT_PATH || parsed.NODE_ENV === "production" ? "mtls" : "plaintext"),
    grpcTls: parsed.CONTROLLER_GRPC_TLS_CERT_PATH && parsed.CONTROLLER_GRPC_TLS_KEY_PATH && parsed.CONTROLLER_GRPC_TLS_CLIENT_CA_PATH
      ? {
          certPath: parsed.CONTROLLER_GRPC_TLS_CERT_PATH,
          keyPath: parsed.CONTROLLER_GRPC_TLS_KEY_PATH,
          clientCaPath: parsed.CONTROLLER_GRPC_TLS_CLIENT_CA_PATH,
        }
      : null,
    databaseUrl: parsed.CONTROLLER_DATABASE_URL,
    databaseTimeouts: {
      statementMs: parsed.CONTROLLER_DATABASE_STATEMENT_TIMEOUT_MS,
      lockMs: parsed.CONTROLLER_DATABASE_LOCK_TIMEOUT_MS,
      idleTransactionMs: parsed.CONTROLLER_DATABASE_IDLE_TRANSACTION_TIMEOUT_MS,
    },
    runnerSyncConcurrency: parsed.CONTROLLER_RUNNER_SYNC_CONCURRENCY,
    publicUrl: parsed.CONTROLLER_PUBLIC_URL.replace(/\/$/, ""),
    runtimeServiceUrl: parsed.CONTROLLER_RUNTIME_SERVICE_URL.replace(/\/$/, ""),
    runtimePublicUrl: parsed.CONTROLLER_RUNTIME_PUBLIC_URL.replace(/\/+$/, "") || null,
    uiDist: parsed.CONTROLLER_UI_DIST,
    policyCatalogDir: parsed.CONTROLLER_POLICY_CATALOG_DIR,
    protoPath: parsed.CONTROLLER_PROTO_PATH,
    migrationsPath: parsed.CONTROLLER_MIGRATIONS_PATH,
    runnerToken: parsed.CONTROLLER_RUNNER_TOKEN,
    metricsToken: parsed.CONTROLLER_METRICS_TOKEN ?? null,
    artifactSigningKeyPath: parsed.CONTROLLER_ARTIFACT_SIGNING_KEY_PATH,
    betterAuthSecret: parsed.BETTER_AUTH_SECRET,
    trustedOrigins: parsed.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean),
    trustedProxyCidrs: parsed.CONTROLLER_TRUSTED_PROXY_CIDRS.split(",").map((item) => item.trim()).filter(Boolean),
    minPasswordLength: parsed.BETTER_AUTH_MIN_PASSWORD_LENGTH,
    bootstrapAdmin: parsed.CONTROLLER_BOOTSTRAP_ADMIN_USERNAME && parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD
      ? { username: parsed.CONTROLLER_BOOTSTRAP_ADMIN_USERNAME, password: parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD, name: parsed.CONTROLLER_BOOTSTRAP_ADMIN_NAME, ...(parsed.CONTROLLER_BOOTSTRAP_ADMIN_REVISION ? { revision: parsed.CONTROLLER_BOOTSTRAP_ADMIN_REVISION } : {}) }
      : null,
    bootstrapUser: parsed.CONTROLLER_BOOTSTRAP_USER_USERNAME && parsed.CONTROLLER_BOOTSTRAP_USER_PASSWORD
      ? { username: parsed.CONTROLLER_BOOTSTRAP_USER_USERNAME, password: parsed.CONTROLLER_BOOTSTRAP_USER_PASSWORD, name: parsed.CONTROLLER_BOOTSTRAP_USER_NAME, ...(parsed.CONTROLLER_BOOTSTRAP_USER_REVISION ? { revision: parsed.CONTROLLER_BOOTSTRAP_USER_REVISION } : {}) }
      : null,
    controlPlaneAi,
    playgroundChat,
    runtimeLogEncryptionKey: parsed.MODEL_GUARDRAILS_RUNTIME_LOG_ENCRYPTION_KEY ?? null,
    heartbeatIntervalSeconds: parsed.RUNNER_HEARTBEAT_INTERVAL_SECONDS,
    offlineAfterSeconds: parsed.RUNNER_OFFLINE_AFTER_SECONDS,
    deletionTrafficWindowMinutes: parsed.DELETE_TRAFFIC_WINDOW_MINUTES,
    telemetryStaleAfterSeconds: parsed.TELEMETRY_STALE_AFTER_SECONDS,
    modelConnections: {
      controlPlane: {
        provider: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_PROVIDER,
        model: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL ?? "not-configured",
      },
      dataPlane: {
        provider: "Runner",
        models: [
          ...modelRuntimes.map((item) => ({
            id: item.id,
            model: item.model,
          })),
          ...(automatedReasoningUrl
            ? [{ id: "automated-reasoning", model: automatedReasoningUrl }]
            : []),
        ],
      },
    },
  } as const;
}
