import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  min,
  or,
  sum,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { ControllerDatabase } from "../db/client.js";
import { boundedRead } from "../db/read-budget.js";
import {
  deployments,
  guardrails,
  integrations,
  runtimeEvents as event,
  validationRuns,
} from "../db/schema.js";
import {
  asText,
  choose,
  coalesce,
  countWhere,
  distinctArray,
  distinctCountWhere,
  findingSeverity,
  jsonArrayKey,
  jsonElements,
  jsonText,
  jsonValue,
  literal,
  lowerText,
  numericJson,
  percentiles,
  timeBucket,
} from "../db/postgres-expressions.js";
import {
  assembleMetrics,
  metricWindows,
  type MetricScope,
} from "./runtime-metric-results.js";

export {
  assembleMetrics,
  metricWindows,
  type MetricScope,
} from "./runtime-metric-results.js";

export async function queryRuntimeMetrics(
  db: ControllerDatabase,
  scope: MetricScope,
) {
  const now = Date.now();
  const duration = metricWindows[scope.window];
  const start = new Date(now - duration);
  const interval = (
    { "1h": "1m", "24h": "15m", "7d": "1h", "15d": "6h", "30d": "1d" } as const
  )[scope.window];
  const step = {
    "1m": 60_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "6h": 21_600_000,
    "1d": 86_400_000,
  }[interval];
  const predicate = and(
    gte(event.occurredAt, new Date(now - duration * 2)),
    // Allow small clock skew between the app process and PostgreSQL.
    lte(event.occurredAt, new Date(now + 60_000)),
    scope.guardrailId ? eq(event.guardrailId, scope.guardrailId) : undefined,
    scope.deploymentId ? eq(event.deploymentId, scope.deploymentId) : undefined,
  );
  const currentPredicate = and(predicate, gte(event.occurredAt, start));

  return boundedRead(db, async (tx, execute) => {
    const decision = lowerText(event.decision);
    const outcome = choose<string>(
      inArray(decision, ["allow", "allowed", "pass", "passed"]),
      literal("allow"),
      choose(
        inArray(decision, [
          "transform",
          "transformed",
          "redact",
          "redacted",
          "rewrite",
          "rewritten",
          "intervene",
          "intervened",
        ]),
        literal("transform"),
        choose(
          inArray(decision, [
            "block",
            "blocked",
            "reject",
            "rejected",
            "deny",
            "denied",
          ]),
          literal("block"),
          choose(
            inArray(decision, [
              "error",
              "failed",
              "failure",
              "timeout",
              "timed_out",
            ]),
            literal("error"),
            event.decision,
          ),
        ),
      ),
    );

    // Referenced by multiple dimensions: PostgreSQL materializes this compact CTE.
    // Neither event contents nor individual traces are selected into the result.
    const base = tx.$with("metric_events").as(
      tx
        .select({
          occurred_at: event.occurredAt,
          guardrail_id: event.guardrailId,
          guardrail_version: event.guardrailVersion,
          integration_id: event.integrationId,
          deployment_id: event.deploymentId,
          duration_ms: event.durationMs,
          current: gte(event.occurredAt, start).as("current"),
          timed_out: or(
            inArray(decision, ["timeout", "timed_out"]),
            eq(jsonText(event.metadata, "timedOut"), "true"),
            eq(jsonText(event.metadata, "timed_out"), "true"),
          )!.as("timed_out"),
          has_evidence: isNotNull(jsonText(event.metadata, "captureLevel")).as(
            "has_evidence",
          ),
          protocol: jsonText(event.metadata, "protocol").as("protocol"),
          engine: jsonText(event.metadata, "runtimeEngine").as("engine"),
          checksum: jsonText(event.metadata, "configChecksum").as("checksum"),
          usage: jsonValue(event.metadata, "usage").as("usage"),
          outcome: outcome.as("outcome"),
        })
        .from(event)
        .where(predicate),
    );
    const baseColumns = {
      occurred_at: base.occurred_at,
      guardrail_id: base.guardrail_id,
      guardrail_version: base.guardrail_version,
      integration_id: base.integration_id,
      deployment_id: base.deployment_id,
      duration_ms: base.duration_ms,
      current: base.current,
      timed_out: base.timed_out,
      has_evidence: base.has_evidence,
      protocol: base.protocol,
      engine: base.engine,
      checksum: base.checksum,
      usage: base.usage,
      outcome: base.outcome,
    };
    const dimension = (kind: string, key: SQL<string>, filter?: SQLWrapper) =>
      tx
        .select({
          ...baseColumns,
          kind: literal(kind).as("kind"),
          key: key.as("key"),
        })
        .from(base)
        .where(and(filter));
    const bucket = timeBucket(base.occurred_at, step);
    const groups = unionAll(
      dimension(
        "period",
        choose(base.current, literal("current"), literal("previous")),
      ),
      dimension(
        "guardrail",
        coalesce(base.guardrail_id, literal("")),
        base.current,
      ),
      dimension(
        "caller",
        jsonArrayKey(base.integration_id, base.deployment_id),
        base.current,
      ),
      dimension(
        "version",
        jsonArrayKey(base.guardrail_id, base.guardrail_version),
        base.current,
      ),
      dimension(
        "engine",
        coalesce(
          jsonText(base.usage, "runtime_engine"),
          base.engine,
          literal("unknown"),
        ),
        base.current,
      ),
      dimension("trend", asText(bucket), base.current),
      dimension(
        "guardrail-trend",
        jsonArrayKey(base.guardrail_id, bucket),
        base.current,
      ),
    ).as("event_dimensions");
    const usageSum = (key: string) =>
      coalesce<number>(sum(numericJson(groups.usage, key)), literal(0));
    const totals = await execute(
      tx
        .with(base)
        .select({
          kind: groups.kind,
          key: groups.key,
          total: count(),
          allowed: countWhere(eq(groups.outcome, "allow")),
          blocked: countWhere(eq(groups.outcome, "block")),
          intervened: countWhere(eq(groups.outcome, "transform")),
          errors: countWhere(eq(groups.outcome, "error")),
          timeout_count: countWhere(groups.timed_out),
          evidence: countWhere(groups.has_evidence),
          fail_closed_count: countWhere(
            eq(jsonText(groups.usage, "fail_closed"), "true"),
          ),
          slo_breach_count: countWhere(gt(groups.duration_ms, 2500)),
          unassigned: countWhere(isNull(groups.deployment_id)),
          degraded_integrations: distinctCountWhere(
            groups.integration_id,
            eq(groups.outcome, "error"),
          ),
          latency: percentiles(groups.duration_ms),
          queue: percentiles(numericJson(groups.usage, "queue_latency_ms")),
          provider: percentiles(
            numericJson(groups.usage, "provider_latency_ms"),
          ),
          peak_active_concurrency: coalesce<number>(
            max(numericJson(groups.usage, "active_concurrency")),
            literal(0),
          ),
          rail_invocations: usageSum("rail_invocations"),
          action_invocations: usageSum("action_invocations"),
          model_invocations: usageSum("model_invocations"),
          cache_hits: usageSum("cache_hits"),
          cache_misses: usageSum("cache_misses"),
          runtime_engines: distinctArray(
            coalesce(
              jsonText(groups.usage, "runtime_engine"),
              groups.engine,
              literal("unknown"),
            ),
          ),
          config_checksums: distinctArray(
            coalesce(
              jsonText(groups.usage, "config_checksum"),
              groups.checksum,
            ),
          ),
          versions: distinctArray(groups.guardrail_version),
          protocol: min(groups.protocol),
        })
        .from(groups)
        .groupBy(groups.kind, groups.key),
    );

    // Extract primitive step fields once, before expanding into aggregate dimensions.
    const trace = jsonElements(
      jsonValue(event.metadata, "trace"),
      "trace_step",
    );
    const stepText = (key: string) => jsonText(trace.item, key);
    const steps = tx.$with("metric_steps").as(
      tx
        .select({
          guardrail_id: event.guardrailId,
          step_kind: stepText("kind").as("step_kind"),
          name: coalesce<string>(
            stepText("name"),
            stepText("actionName"),
            stepText("flowName"),
            literal("runtime-step"),
          ).as("name"),
          risk: stepText("risk").as("risk"),
          policy_id: stepText("policyId").as("policy_id"),
          policy_version: stepText("policyVersion").as("policy_version"),
          rail_type: stepText("railType").as("rail_type"),
          flow_name: stepText("flowName").as("flow_name"),
          action_name: stepText("actionName").as("action_name"),
          action_version: stepText("actionVersion").as("action_version"),
          parallel_group: stepText("parallelGroup").as("parallel_group"),
          outcome: coalesce<string>(
            stepText("outcome"),
            stepText("status"),
            stepText("verdict"),
          ).as("outcome"),
          timed_out: eq(stepText("timedOut"), "true").as("timed_out"),
          duration: coalesce<number>(
            numericJson(trace.item, "durationMs"),
            literal(0),
          ).as("duration"),
          provider: coalesce<number>(
            numericJson(trace.item, "providerLatencyMs"),
            literal(0),
          ).as("provider"),
        })
        .from(event)
        .innerJoin(trace.source, eq(event.id, event.id))
        .where(currentPredicate),
    );
    const stepColumns = {
      risk: steps.risk,
      policy_id: steps.policy_id,
      policy_version: steps.policy_version,
      rail_type: steps.rail_type,
      flow_name: steps.flow_name,
      action_name: steps.action_name,
      action_version: steps.action_version,
      parallel_group: steps.parallel_group,
      outcome: steps.outcome,
      timed_out: steps.timed_out,
      duration: steps.duration,
      provider: steps.provider,
    };
    const componentGroups = unionAll(
      tx
        .select({
          ...stepColumns,
          scope: literal<string>("").as("scope"),
          kind: steps.step_kind,
          key: steps.name,
        })
        .from(steps)
        .where(inArray(steps.step_kind, ["rail", "action"])),
      tx
        .select({
          ...stepColumns,
          scope: coalesce<string>(steps.guardrail_id, literal("")).as("scope"),
          kind: steps.step_kind,
          key: steps.name,
        })
        .from(steps)
        .where(
          and(
            isNotNull(steps.guardrail_id),
            inArray(steps.step_kind, ["rail", "action"]),
          ),
        ),
      tx
        .select({
          ...stepColumns,
          scope: literal<string>("").as("scope"),
          kind: literal("policy").as("kind"),
          key: coalesce<string>(steps.policy_id, literal("")).as("name"),
        })
        .from(steps)
        .where(isNotNull(steps.policy_id)),
    ).as("component_dimensions");
    const c = componentGroups;
    const components = await execute(
      tx
        .with(steps)
        .select({
          scope: c.scope,
          kind: c.kind,
          key: c.key,
          invocations: count(),
          risk: min(c.risk),
          policy_id: min(c.policy_id),
          policy_version: min(c.policy_version),
          rail_type: min(c.rail_type),
          flow_name: min(c.flow_name),
          action_name: min(c.action_name),
          action_version: min(c.action_version),
          parallel_group: min(c.parallel_group),
          rail_types: distinctArray(c.rail_type),
          parallel_groups: distinctArray(c.parallel_group),
          passed: countWhere(
            inArray(c.outcome, ["passed", "safe", "allow", "complete"]),
          ),
          intervened: countWhere(
            inArray(c.outcome, [
              "unsafe",
              "block",
              "transform",
              "intervene",
              "enforce",
            ]),
          ),
          errors: countWhere(eq(c.outcome, "error")),
          uncertain: countWhere(eq(c.outcome, "uncertain")),
          timeouts: countWhere(c.timed_out),
          latency: percentiles(c.duration),
          provider: percentiles(c.provider),
        })
        .from(c)
        .groupBy(c.scope, c.kind, c.key),
    );

    const finding = jsonElements(
      jsonValue(event.metadata, "findings"),
      "event_finding",
    );
    const findingRows = tx.$with("metric_findings").as(
      tx
        .select({
          request_id: event.requestId,
          occurred_at: event.occurredAt,
          risk: coalesce<string>(
            jsonText(finding.item, "risk"),
            literal("unknown"),
          ).as("risk"),
          severity: findingSeverity(finding.item).as("severity"),
        })
        .from(event)
        .innerJoin(finding.source, eq(event.id, event.id))
        .where(currentPredicate),
    );
    const risks = await execute(
      tx
        .with(findingRows)
        .select({ risk: findingRows.risk, count: count() })
        .from(findingRows)
        .groupBy(findingRows.risk),
    );
    const findings = await execute(
      tx
        .with(findingRows)
        .select({
          total: count(),
          critical: countWhere(eq(findingRows.severity, "critical")),
          high: countWhere(eq(findingRows.severity, "high")),
          medium: countWhere(eq(findingRows.severity, "medium")),
          low: countWhere(eq(findingRows.severity, "low")),
          affected_traces: countDistinct(findingRows.request_id),
          latest_at: max(findingRows.occurred_at),
        })
        .from(findingRows),
    );

    const validation = tx
      .select({
        source_draft_revision: validationRuns.sourceDraftRevision,
        status: validationRuns.status,
        p95: coalesce<number>(
          numericJson(validationRuns.metrics, "p95LatencyMs"),
          literal(0),
        ).as("p95"),
      })
      .from(validationRuns)
      .where(eq(validationRuns.guardrailId, guardrails.id))
      .orderBy(desc(validationRuns.createdAt))
      .limit(1)
      .as("latest_validation");
    const guards = await execute(
      tx
        .select({
          id: guardrails.id,
          name: guardrails.name,
          draft_revision: guardrails.draftRevision,
          source_draft_revision: validation.source_draft_revision,
          status: validation.status,
          p95: coalesce<number>(validation.p95, literal(0)),
        })
        .from(guardrails)
        .leftJoinLateral(validation, eq(guardrails.id, guardrails.id))
        .where(isNull(guardrails.deletedAt)),
    );
    const deps = await execute(
      tx
        .select({
          id: deployments.id,
          name: deployments.name,
          guardrail_id: deployments.guardrailId,
          enabled: deployments.enabled,
        })
        .from(deployments)
        .where(isNull(deployments.deletedAt)),
    );
    const ints = await execute(
      tx
        .select({ id: integrations.id, name: integrations.name })
        .from(integrations)
        .where(isNull(integrations.deletedAt)),
    );
    return {
      ...assembleMetrics(
        scope,
        now,
        step,
        interval,
        totals,
        components,
        risks,
        guards,
        deps,
        ints,
      ),
      findings_summary: findings[0],
    };
  });
}
