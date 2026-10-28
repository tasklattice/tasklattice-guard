import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

// Kubernetes mounts the complete account Secret; protocol-specific field names
// live in the application image rather than the deployment package.
export function clusterBootstrapEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (environment.CONTROLLER_MIN_LOGIN_LENGTH) result.BETTER_AUTH_MIN_PASSWORD_LENGTH = environment.CONTROLLER_MIN_LOGIN_LENGTH;
  for (const role of ["ADMIN", "USER"]) {
    const prefix = `CONTROLLER_BOOTSTRAP_${role}`;
    const directory = environment[`${prefix}_DIRECTORY`];
    if (!directory) continue;
    // Resolve Kubernetes' atomic projection once so a refresh cannot mix
    // fields from two Secret revisions while this account is being read.
    const projection = join(directory, "..data");
    const source = existsSync(projection) ? realpathSync(projection) : directory;
    const fields = JSON.parse(environment[`${prefix}_FIELDS`] || "{}") as Record<string, string>;
    for (const [suffix, key] of [
      ["USERNAME", fields.usernameKey || "username"],
      ["NAME", fields.nameKey || "name"],
      ["PASSWORD", fields.credentialKey || "password"],
    ] as const) {
      if (key === "." || key === ".." || key.includes("/") || key.includes("\\")) throw new Error("Invalid bootstrap Secret field name.");
      const path = join(source, key);
      result[`${prefix}_${suffix}`] = readFileSync(path, "utf8");
    }
    const revisionPath = join(source, "revision");
    result[`${prefix}_REVISION`] = existsSync(revisionPath) ? readFileSync(revisionPath, "utf8") : undefined;
  }
  return result;
}
