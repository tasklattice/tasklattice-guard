import { z } from "zod";

import { usernameSchema } from "../shared/username.js";
import { projectNameSchema } from "../shared/runner-naming.js";
import { clusterBootstrapEnvironment } from "./cluster-bootstrap.js";
import { loadSsoConfig } from "./sso-config.js";
import { defaultEndpointContextStorageLimits, validateEndpointContextStorageLimits } from "./endpoint-context-storage-policy.js";

function isCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split("/");
  if (!address || !prefix || rest.length) return false;
  const bits = Number(prefix);
  if (!Number.isInteger(bits)) return false;
  if (z.ipv4().safeParse(address).success) return bits >= 0 && bits <= 32;
  if (z.ipv6().safeParse(address).success) return bits >= 0 && bits <= 128;
  return false;
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
  // Optional first step toward pool identities. When present the control
  // channel accepts only these pool credentials, never the legacy token.
  CONTROLLER_RUNNER_POOL_TOKENS_JSON: z.string().optional(),
  // Separate Controller-to-Runner internal HTTP authority, one token per pool.
  CONTROLLER_RUNNER_HTTP_TOKENS_JSON: z.string().optional(),
  // Experimental: scope Playground telemetry by authenticated pool. Other
  // origins are quarantined until their allocation provenance is available.
  CONTROLLER_RUNNER_SCOPED_TELEMETRY: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
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
  CONTROLLER_BOOTSTRAP_USER_USERNAME: usernameSchema.optional(),
  CONTROLLER_BOOTSTRAP_USER_REVISION: z.string().optional(),
  CONTROLLER_BOOTSTRAP_USER_PASSWORD: z.string().min(1).max(128).optional(),
  CONTROLLER_BOOTSTRAP_USER_PROJECT: projectNameSchema.optional(),
  MODEL_GUARDRAILS_RUNTIME_LOG_ENCRYPTION_KEY: z.string().trim().min(1).optional(),
  RUNNER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(2).max(60).default(10),
  RUNNER_OFFLINE_AFTER_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  DELETE_TRAFFIC_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  TELEMETRY_STALE_AFTER_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
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
  if (parsed.CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS && !runnerPoolTokens) {
    throw new Error("CONTROLLER_EXPERIMENTAL_RUNNER_LEASE_GRANTS requires CONTROLLER_RUNNER_POOL_TOKENS_JSON.");
  }
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
    runnerPoolTokens,
    runnerHttpTokens,
    runnerScopedTelemetry: parsed.CONTROLLER_RUNNER_SCOPED_TELEMETRY,
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
    sso: loadSsoConfig(environment),
    trustedOrigins: parsed.BETTER_AUTH_TRUSTED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean),
    trustedProxyCidrs: parsed.CONTROLLER_TRUSTED_PROXY_CIDRS.split(",").map((item) => item.trim()).filter(Boolean),
    minPasswordLength: parsed.BETTER_AUTH_MIN_PASSWORD_LENGTH,
    bootstrapAdmin: parsed.CONTROLLER_BOOTSTRAP_ADMIN_USERNAME && parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD
      ? { username: parsed.CONTROLLER_BOOTSTRAP_ADMIN_USERNAME, password: parsed.CONTROLLER_BOOTSTRAP_ADMIN_PASSWORD, ...(parsed.CONTROLLER_BOOTSTRAP_ADMIN_REVISION ? { revision: parsed.CONTROLLER_BOOTSTRAP_ADMIN_REVISION } : {}) }
      : null,
    bootstrapUser: parsed.CONTROLLER_BOOTSTRAP_USER_USERNAME && parsed.CONTROLLER_BOOTSTRAP_USER_PASSWORD
      ? { username: parsed.CONTROLLER_BOOTSTRAP_USER_USERNAME, password: parsed.CONTROLLER_BOOTSTRAP_USER_PASSWORD, ...(parsed.CONTROLLER_BOOTSTRAP_USER_REVISION ? { revision: parsed.CONTROLLER_BOOTSTRAP_USER_REVISION } : {}), ...(parsed.CONTROLLER_BOOTSTRAP_USER_PROJECT ? { project: parsed.CONTROLLER_BOOTSTRAP_USER_PROJECT } : {}) }
      : null,
    runtimeLogEncryptionKey: parsed.MODEL_GUARDRAILS_RUNTIME_LOG_ENCRYPTION_KEY ?? null,
    heartbeatIntervalSeconds: parsed.RUNNER_HEARTBEAT_INTERVAL_SECONDS,
    offlineAfterSeconds: parsed.RUNNER_OFFLINE_AFTER_SECONDS,
    deletionTrafficWindowMinutes: parsed.DELETE_TRAFFIC_WINDOW_MINUTES,
    telemetryStaleAfterSeconds: parsed.TELEMETRY_STALE_AFTER_SECONDS,
  } as const;
}
