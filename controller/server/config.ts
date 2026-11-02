import { z } from "zod";

import { bootstrapPasswordHashPattern } from "./bootstrap-password.js";
import { clusterBootstrapEnvironment } from "./cluster-bootstrap.js";
import { defaultEndpointContextStorageLimits, validateEndpointContextStorageLimits } from "./endpoint-context-storage-policy.js";

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
  // Optional first step toward pool identities. When present the control
  // channel accepts only these pool credentials, never the legacy token.
  CONTROLLER_RUNNER_POOL_TOKENS_JSON: z.string().optional(),
  // Separate Controller-to-Runner internal HTTP authority, one token per pool.
  CONTROLLER_RUNNER_HTTP_TOKENS_JSON: z.string().optional(),
  // Experimental: scope Playground telemetry by authenticated pool. Other
  // origins are quarantined until their allocation provenance is available.
  CONTROLLER_RUNNER_SCOPED_TELEMETRY: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  CONTROLLER_RUNNER_TELEMETRY_PROGRESS: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_PER_POOL: z.coerce.number().int().positive().max(1_000_000).default(defaultEndpointContextStorageLimits.maxRowsPerPool),
  CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_GLOBAL: z.coerce.number().int().positive().max(1_000_000).default(defaultEndpointContextStorageLimits.maxRowsGlobal),
  CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_PER_CONTEXT: z.coerce.number().int().positive().max(2_147_483_647).default(defaultEndpointContextStorageLimits.maxPayloadBytesPerContext),
  CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_PER_POOL: z.coerce.number().int().positive().max(2_147_483_647).default(defaultEndpointContextStorageLimits.maxPayloadBytesPerPool),
  CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_GLOBAL: z.coerce.number().int().positive().max(2_147_483_647).default(defaultEndpointContextStorageLimits.maxPayloadBytesGlobal),
  // Experimental protocol probe only; no Runner serving or move uses grants.
  CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  CONTROLLER_METRICS_TOKEN: z.string().min(32).optional(),
  CONTROLLER_ARTIFACT_SIGNING_KEY_PATH: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().default("http://localhost:8080,http://localhost:8092"),
  BETTER_AUTH_MIN_PASSWORD_LENGTH: z.coerce.number().int().min(5).max(128).default(12),
  CONTROLLER_MOCK_SSO_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  CONTROLLER_TENANT_LOAD_LAB_URL: z.string().url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash && ["", "/"].includes(url.pathname);
  }, "Tenant load lab must be an HTTP(S) origin without credentials or a path.").optional(),
  CONTROLLER_BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(1).optional(),
  CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH: z.string().regex(bootstrapPasswordHashPattern, "Expected a Better Auth scrypt password hash.").optional(),
  CONTROLLER_BOOTSTRAP_ADMIN_NAME: z.string().min(1).default("Administrator"),
  CONTROLLER_BOOTSTRAP_USER_EMAIL: z.string().email().optional(),
  CONTROLLER_BOOTSTRAP_USER_PASSWORD: z.string().min(1).optional(),
  CONTROLLER_BOOTSTRAP_USER_PASSWORD_HASH: z.string().regex(bootstrapPasswordHashPattern, "Expected a Better Auth scrypt password hash.").optional(),
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
  const publicHostname = new URL(value.CONTROLLER_PUBLIC_URL).hostname;
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(publicHostname);
  if (value.NODE_ENV === "production" && !value.CONTROLLER_METRICS_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["CONTROLLER_METRICS_TOKEN"],
      message: "CONTROLLER_METRICS_TOKEN is required in production.",
    });
  }

  const localBind = ["localhost", "127.0.0.1", "::1"].includes(value.CONTROLLER_HTTP_HOST);
  if (value.CONTROLLER_MOCK_SSO_ENABLED && (value.NODE_ENV === "production" || !isLoopback || !localBind)) {
    context.addIssue({
      code: "custom",
      path: ["CONTROLLER_MOCK_SSO_ENABLED"],
      message: "Mock SSO is available only outside production with a loopback Controller URL and HTTP bind address.",
    });
  }
  if (Boolean(value.CONTROLLER_BOOTSTRAP_ADMIN_EMAIL) !== Boolean(value.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD || value.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH)) {
    context.addIssue({
      code: "custom",
      message: "Bootstrap email requires either CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD or CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH, and vice versa.",
    });
  }
  if (value.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD && value.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH) {
    context.addIssue({ code: "custom", message: "Bootstrap password and passwordHash are mutually exclusive." });
  }
  if (
    value.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD
    && value.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD.length < value.BETTER_AUTH_MIN_PASSWORD_LENGTH
  ) {
    context.addIssue({
      code: "custom",
      path: ["CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD"],
      message: `CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD must contain at least ${value.BETTER_AUTH_MIN_PASSWORD_LENGTH} characters.`,
    });
  }
  if (Boolean(value.CONTROLLER_BOOTSTRAP_USER_EMAIL) !== Boolean(value.CONTROLLER_BOOTSTRAP_USER_PASSWORD || value.CONTROLLER_BOOTSTRAP_USER_PASSWORD_HASH)) {
    context.addIssue({ code: "custom", message: "Bootstrap user email requires either CONTROLLER_BOOTSTRAP_USER_PASSWORD or CONTROLLER_BOOTSTRAP_USER_PASSWORD_HASH, and vice versa." });
  }
  if (value.CONTROLLER_BOOTSTRAP_USER_PASSWORD && value.CONTROLLER_BOOTSTRAP_USER_PASSWORD_HASH) {
    context.addIssue({ code: "custom", message: "Bootstrap user password and passwordHash are mutually exclusive." });
  }
  if (value.CONTROLLER_BOOTSTRAP_USER_PASSWORD && value.CONTROLLER_BOOTSTRAP_USER_PASSWORD.length < value.BETTER_AUTH_MIN_PASSWORD_LENGTH) {
    context.addIssue({ code: "custom", path: ["CONTROLLER_BOOTSTRAP_USER_PASSWORD"], message: `CONTROLLER_BOOTSTRAP_USER_PASSWORD must contain at least ${value.BETTER_AUTH_MIN_PASSWORD_LENGTH} characters.` });
  }
  if (value.CONTROLLER_BOOTSTRAP_USER_EMAIL && value.CONTROLLER_BOOTSTRAP_USER_EMAIL.toLowerCase() === value.CONTROLLER_BOOTSTRAP_ADMIN_EMAIL?.toLowerCase()) {
    context.addIssue({ code: "custom", message: "Bootstrap admin and user must have different email addresses." });
  }
});

export type ControllerConfig = ReturnType<typeof loadConfig>;

/** Parse secret configuration without including credential values in errors. */
function parseRunnerPoolTokens(raw: string | undefined, legacyToken: string,
  setting = "CONTROLLER_RUNNER_POOL_TOKENS_JSON"): ReadonlyMap<string, string> | null {
  if (raw === undefined) return null;
  const invalid = () => new Error(`${setting} must be a non-empty object mapping unique pool IDs to distinct tokens of at least 32 printable ASCII characters without whitespace; tokens must differ from the legacy token.`);
  const entries = parseFlatSecretMap(raw, invalid);
  if (!entries.length) throw invalid();
  const tokens = new Set<string>();
  const poolTokens = new Map<string, string>();
  for (const [poolId, token] of entries) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(poolId)
      || typeof token !== "string" || token.length < 32 || /[^\x21-\x7e]/.test(token)
      || token === legacyToken || tokens.has(token)) throw invalid();
    tokens.add(token);
    poolTokens.set(poolId, token);
  }
  return poolTokens;
}

/** JSON.parse overwrites duplicate properties. Parse this deliberately narrow
 * object-of-strings format without losing duplicate (including escaped) keys. */
function parseFlatSecretMap(raw: string, invalid: () => Error): Array<[string, string]> {
  let cursor = 0;
  const whitespace = () => { while (/[ \t\r\n]/.test(raw.charAt(cursor)) && cursor < raw.length) cursor++; };
  const consume = (expected: string) => {
    whitespace();
    if (raw.charAt(cursor++) !== expected) throw invalid();
  };
  const string = (): string => {
    whitespace();
    const start = cursor;
    if (raw.charAt(cursor++) !== '"') throw invalid();
    while (cursor < raw.length) {
      const character = raw.charAt(cursor++);
      if (character === "\\") { cursor++; continue; }
      if (character === '"') {
        try { return JSON.parse(raw.slice(start, cursor)) as string; } catch { throw invalid(); }
      }
    }
    throw invalid();
  };
  consume("{");
  whitespace();
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  if (raw.charAt(cursor) !== "}") {
    while (true) {
      const key = string();
      if (seen.has(key)) throw invalid();
      seen.add(key);
      consume(":");
      entries.push([key, string()]);
      whitespace();
      if (raw.charAt(cursor) !== ",") break;
      cursor++;
    }
  }
  consume("}");
  whitespace();
  if (cursor !== raw.length) throw invalid();
  return entries;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  environment = clusterBootstrapEnvironment(environment);
  const parsed = environmentSchema.parse(environment);
  const runnerPoolTokens = parseRunnerPoolTokens(parsed.CONTROLLER_RUNNER_POOL_TOKENS_JSON, parsed.CONTROLLER_RUNNER_TOKEN);
  const runnerHttpTokens = parseRunnerPoolTokens(parsed.CONTROLLER_RUNNER_HTTP_TOKENS_JSON, parsed.CONTROLLER_RUNNER_TOKEN,
    "CONTROLLER_RUNNER_HTTP_TOKENS_JSON");
  if (runnerHttpTokens) {
    if (!runnerPoolTokens || runnerPoolTokens.size !== runnerHttpTokens.size ||
        [...runnerPoolTokens.keys()].some(poolId => !runnerHttpTokens.has(poolId))) {
      throw new Error("CONTROLLER_RUNNER_HTTP_TOKENS_JSON requires exactly the pool IDs configured in CONTROLLER_RUNNER_POOL_TOKENS_JSON.");
    }
    const controlTokens = new Set(runnerPoolTokens.values());
    if ([...runnerHttpTokens.values()].some(token => controlTokens.has(token))) {
      throw new Error("Controller-to-Runner HTTP tokens must differ from all Runner pool control tokens.");
    }
  }
  if (parsed.CONTROLLER_RUNNER_SCOPED_TELEMETRY && !runnerPoolTokens) {
    throw new Error("CONTROLLER_RUNNER_SCOPED_TELEMETRY requires CONTROLLER_RUNNER_POOL_TOKENS_JSON.");
  }
  if (parsed.CONTROLLER_RUNNER_TELEMETRY_PROGRESS && !parsed.CONTROLLER_RUNNER_SCOPED_TELEMETRY) {
    throw new Error("CONTROLLER_RUNNER_TELEMETRY_PROGRESS requires scoped telemetry and pool authentication.");
  }
  if (parsed.CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS && !runnerPoolTokens) {
    throw new Error("CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS requires CONTROLLER_RUNNER_POOL_TOKENS_JSON.");
  }
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
    publicUrl: parsed.CONTROLLER_PUBLIC_URL.replace(/\/$/, ""),
    runtimeServiceUrl: parsed.CONTROLLER_RUNTIME_SERVICE_URL.replace(/\/$/, ""),
    runtimePublicUrl: parsed.CONTROLLER_RUNTIME_PUBLIC_URL.replace(/\/+$/, "") || null,
    uiDist: parsed.CONTROLLER_UI_DIST,
    policyCatalogDir: parsed.CONTROLLER_POLICY_CATALOG_DIR,
    protoPath: parsed.CONTROLLER_PROTO_PATH,
    migrationsPath: parsed.CONTROLLER_MIGRATIONS_PATH,
    runnerToken: parsed.CONTROLLER_RUNNER_TOKEN,
    runnerPoolTokens,
    runnerHttpTokens,
    runnerScopedTelemetry: parsed.CONTROLLER_RUNNER_SCOPED_TELEMETRY,
    runnerTelemetryProgress: parsed.CONTROLLER_RUNNER_TELEMETRY_PROGRESS,
    endpointContextStorage: validateEndpointContextStorageLimits({
      maxRowsPerPool: parsed.CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_PER_POOL,
      maxRowsGlobal: parsed.CONTROLLER_ENDPOINT_CONTEXT_MAX_ROWS_GLOBAL,
      maxPayloadBytesPerContext: parsed.CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_PER_CONTEXT,
      maxPayloadBytesPerPool: parsed.CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_PER_POOL,
      maxPayloadBytesGlobal: parsed.CONTROLLER_ENDPOINT_CONTEXT_MAX_PAYLOAD_BYTES_GLOBAL,
    }),
    experimentalRunnerLeaseGrants: parsed.CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS,
    metricsToken: parsed.CONTROLLER_METRICS_TOKEN ?? null,
    artifactSigningKeyPath: parsed.CONTROLLER_ARTIFACT_SIGNING_KEY_PATH,
    betterAuthSecret: parsed.BETTER_AUTH_SECRET,
    trustedOrigins: parsed.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean),
    minPasswordLength: parsed.BETTER_AUTH_MIN_PASSWORD_LENGTH,
    mockSsoEnabled: parsed.CONTROLLER_MOCK_SSO_ENABLED,
    tenantLoadLabUrl: parsed.CONTROLLER_TENANT_LOAD_LAB_URL ?? null,
    bootstrapAdmin: parsed.CONTROLLER_BOOTSTRAP_ADMIN_EMAIL && (parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD || parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH)
      ? {
          email: parsed.CONTROLLER_BOOTSTRAP_ADMIN_EMAIL,
          ...(parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD ? { password: parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD } : {}),
          ...(parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH ? { passwordHash: parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD_HASH } : {}),
          name: parsed.CONTROLLER_BOOTSTRAP_ADMIN_NAME,
        }
      : null,
    bootstrapUser: parsed.CONTROLLER_BOOTSTRAP_USER_EMAIL && (parsed.CONTROLLER_BOOTSTRAP_USER_PASSWORD || parsed.CONTROLLER_BOOTSTRAP_USER_PASSWORD_HASH)
      ? {
          email: parsed.CONTROLLER_BOOTSTRAP_USER_EMAIL,
          ...(parsed.CONTROLLER_BOOTSTRAP_USER_PASSWORD ? { password: parsed.CONTROLLER_BOOTSTRAP_USER_PASSWORD } : {}),
          ...(parsed.CONTROLLER_BOOTSTRAP_USER_PASSWORD_HASH ? { passwordHash: parsed.CONTROLLER_BOOTSTRAP_USER_PASSWORD_HASH } : {}),
          name: parsed.CONTROLLER_BOOTSTRAP_USER_NAME,
        }
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
