import { sql } from "drizzle-orm";
import { projects, runnerPools } from "../db/schema.js";

/** A dedicated pool owns one Project; only default may serve unassigned Projects. */
export const projectPoolAllocation = sql`${projects.groupId} = ${runnerPools.groupId} and (
  ${runnerPools.projectId} = ${projects.id} or (${runnerPools.id} = 'default' and not exists (
    select 1 from runner_pool dedicated where dedicated.project_id = ${projects.id})))`;
