import { z } from "zod";

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
    "tali.guard.company-policy.v1",
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

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CONTROLLER_HTTP_HOST: z.string().default("0.0.0.0"),
  CONTROLLER_HTTP_PORT: z.coerce.number().int().positive().default(8080),
  CONTROLLER_GRPC_HOST: z.string().default("0.0.0.0"),
  CONTROLLER_GRPC_PORT: z.coerce.number().int().positive().default(9090),
  CONTROLLER_GRPC_TLS_CERT_PATH: z.string().optional(),
  CONTROLLER_GRPC_TLS_KEY_PATH: z.string().optional(),
  CONTROLLER_GRPC_TLS_CLIENT_CA_PATH: z.string().optional(),
  CONTROLLER_DATABASE_URL: z.string().url(),
  CONTROLLER_PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  CONTROLLER_RUNTIME_SERVICE_URL: z.string().url().default("http://localhost:8091"),
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
  BETTER_AUTH_MIN_PASSWORD_LENGTH: z.coerce.number().int().min(5).max(128).default(12),
  CONTROLLER_ALLOW_LOCAL_DEFAULT_CREDENTIALS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CONTROLLER_BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(1).optional(),
  CONTROLLER_BOOTSTRAP_ADMIN_NAME: z.string().min(1).default("Administrator"),
  MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL: z.string().url().optional(),
  MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL: z.string().min(1).optional(),
  MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY: z.string().min(1).optional(),
  MODEL_GUARDRAILS_CONTROL_PLANE_AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(45_000),
  MODEL_GUARDRAILS_PLAYGROUND_CHAT_BASE_URL: z.string().url().optional(),
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
  MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL: z.string().url().optional(),
}).superRefine((value, context) => {
  const publicHostname = new URL(value.CONTROLLER_PUBLIC_URL).hostname;
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(publicHostname);
  const isLocalDefault = value.CONTROLLER_ALLOW_LOCAL_DEFAULT_CREDENTIALS
    && isLoopback
    && value.CONTROLLER_BOOTSTRAP_ADMIN_EMAIL === "admin@tasklattice.local"
    && value.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD === "admin";

  if (value.NODE_ENV === "production" && !value.CONTROLLER_METRICS_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["CONTROLLER_METRICS_TOKEN"],
      message: "CONTROLLER_METRICS_TOKEN is required in production.",
    });
  }

  if (value.CONTROLLER_ALLOW_LOCAL_DEFAULT_CREDENTIALS && !isLoopback) {
    context.addIssue({
      code: "custom",
      path: ["CONTROLLER_ALLOW_LOCAL_DEFAULT_CREDENTIALS"],
      message: "Local default credentials may only be enabled for a loopback Controller URL.",
    });
  }
  if (Boolean(value.CONTROLLER_BOOTSTRAP_ADMIN_EMAIL) !== Boolean(value.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD)) {
    context.addIssue({
      code: "custom",
      message: "CONTROLLER_BOOTSTRAP_ADMIN_EMAIL and CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD must be configured together.",
    });
  }
  if (value.MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL && !value.MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL) {
    context.addIssue({
      code: "custom",
      message: "MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL and MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL must be configured together.",
    });
  }
  if (value.MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY && !value.MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL) {
    context.addIssue({
      code: "custom",
      path: ["MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY"],
      message: "The control-plane AI base URL and model are required when its API key is configured.",
    });
  }
  if (Boolean(value.MODEL_GUARDRAILS_PLAYGROUND_CHAT_BASE_URL) !== Boolean(value.MODEL_GUARDRAILS_PLAYGROUND_CHAT_MODEL)) {
    context.addIssue({ code: "custom", message: "MODEL_GUARDRAILS_PLAYGROUND_CHAT_BASE_URL and MODEL_GUARDRAILS_PLAYGROUND_CHAT_MODEL must be configured together." });
  }
  if (value.MODEL_GUARDRAILS_PLAYGROUND_CHAT_API_KEY && !value.MODEL_GUARDRAILS_PLAYGROUND_CHAT_BASE_URL) {
    context.addIssue({ code: "custom", message: "Playground base URL and model are required when its API key is configured." });
  }
  if (
    value.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD
    && value.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD.length < value.BETTER_AUTH_MIN_PASSWORD_LENGTH
    && !isLocalDefault
  ) {
    context.addIssue({
      code: "custom",
      path: ["CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD"],
      message: `CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD must contain at least ${value.BETTER_AUTH_MIN_PASSWORD_LENGTH} characters.`,
    });
  }
});

export type ControllerConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);
  const modelRuntimes = parseConfiguration(
    parsed.MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON,
    "MODEL_GUARDRAILS_MODEL_RUNTIMES_JSON",
    modelRuntimeList,
  );
  const evaluatorBindings = parseConfiguration(
    parsed.MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON,
    "MODEL_GUARDRAILS_EVALUATOR_BINDINGS_JSON",
    evaluatorBindingList,
  );
  const modelRuntimeIds = new Set(modelRuntimes.map((item) => item.id));
  const unknownRuntimeBindings = evaluatorBindings.filter((item) => !modelRuntimeIds.has(item.model_ref));
  if (unknownRuntimeBindings.length) {
    throw new Error(`Evaluator Bindings reference unknown Model Runtimes: ${unknownRuntimeBindings.map((item) => item.model_ref).join(", ")}.`);
  }
  const controlPlaneAi = parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL
    && parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL
    && parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY
    ? {
        provider: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_PROVIDER,
        baseUrl: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_BASE_URL.replace(/\/$/, ""),
        model: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_MODEL,
        apiKey: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY,
        timeoutMs: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_TIMEOUT_MS,
      }
    : null;
  const playgroundChat = parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_BASE_URL
    && parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_MODEL
    && parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_API_KEY
    ? {
        provider: "OpenAI-compatible",
        baseUrl: parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_BASE_URL.replace(/\/$/, ""),
        model: parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_MODEL,
        apiKey: parsed.MODEL_GUARDRAILS_PLAYGROUND_CHAT_API_KEY,
        timeoutMs: parsed.MODEL_GUARDRAILS_CONTROL_PLANE_AI_TIMEOUT_MS,
      }
    : controlPlaneAi;
  return {
    nodeEnv: parsed.NODE_ENV,
    http: { host: parsed.CONTROLLER_HTTP_HOST, port: parsed.CONTROLLER_HTTP_PORT },
    grpc: { host: parsed.CONTROLLER_GRPC_HOST, port: parsed.CONTROLLER_GRPC_PORT },
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
    uiDist: parsed.CONTROLLER_UI_DIST,
    policyCatalogDir: parsed.CONTROLLER_POLICY_CATALOG_DIR,
    protoPath: parsed.CONTROLLER_PROTO_PATH,
    migrationsPath: parsed.CONTROLLER_MIGRATIONS_PATH,
    runnerToken: parsed.CONTROLLER_RUNNER_TOKEN,
    metricsToken: parsed.CONTROLLER_METRICS_TOKEN ?? null,
    artifactSigningKeyPath: parsed.CONTROLLER_ARTIFACT_SIGNING_KEY_PATH,
    betterAuthSecret: parsed.BETTER_AUTH_SECRET,
    trustedOrigins: parsed.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean),
    minPasswordLength: parsed.BETTER_AUTH_MIN_PASSWORD_LENGTH,
    allowLocalDefaultCredentials: parsed.CONTROLLER_ALLOW_LOCAL_DEFAULT_CREDENTIALS,
    bootstrapAdmin: parsed.CONTROLLER_BOOTSTRAP_ADMIN_EMAIL && parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD
      ? {
          email: parsed.CONTROLLER_BOOTSTRAP_ADMIN_EMAIL,
          password: parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD,
          name: parsed.CONTROLLER_BOOTSTRAP_ADMIN_NAME,
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
          ...(parsed.MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL
            ? [{ id: "automated-reasoning", model: parsed.MODEL_GUARDRAILS_AUTOMATED_REASONING_ENDPOINT_URL }]
            : []),
        ],
      },
    },
  } as const;
}
