// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase } from "../db/postgres-test-database.js";
import { loadConfig } from "../config.js";
import { ProjectService } from "./projects.js";
import { ProjectGroupService } from "./project-groups.js";
import { ProjectGroupRouting } from "./project-group-routing.js";
import { ControlPlaneService } from "./control-plane.js";
import { runWithProjectContext } from "./project-context.js";

const url = process.env.GUARD_TEST_POSTGRES_URL;
describe.skipIf(!url)("Project names and dedicated Runner identity", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let projects: ProjectService, groups: ProjectGroupService, routing: ProjectGroupRouting, control: ControlPlaneService;
  const admin = <T>(fn: () => T) => runWithProjectContext({role:"admin",actorId:"admin"}, fn);
  beforeEach(async () => {
    database = await createTestDatabase(url!, "runner_names");
    await database.pool.query(`INSERT INTO auth_user(id,username,email,role) VALUES ('admin','Admin','admin@test.invalid','admin');
      INSERT INTO runner_pool(id,name,is_default,runtime_url) VALUES ('default','runner-default',true,'http://default.invalid');
      INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',0);`);
    const config = loadConfig({NODE_ENV:"test",CONTROLLER_DATABASE_URL:url!,CONTROLLER_RUNNER_TOKEN:"test-runner-token-at-least-32-characters",
      BETTER_AUTH_SECRET:"test-auth-secret-at-least-32-characters",CONTROLLER_ARTIFACT_SIGNING_KEY_PATH:"/unused.pem"});
    projects = new ProjectService(database.db, async () => {}); groups = new ProjectGroupService(database.db);
    routing = new ProjectGroupRouting(database.db, config); control = new ControlPlaneService(database.db, config);
  });
  afterEach(async () => { await database?.drop(); });
  const create = () => projects.create("admin",{name:" Support_Search "});
  const dedicate = (id: string) => admin(() => groups.createPool("default",{projectId:id,runtimeUrl:"http://support.invalid"},"admin"));
  const registration = (runnerId: string, poolId: string) => control.registerRunner({runnerId,poolId,bootId:"boot",runnerVersion:"test",nemoVersion:"test",compilerCapable:true,maxConcurrency:4,labels:{},appliedGeneration:0});

  it("normalizes once, uses the canonical name as identity, prevents duplicates and rejects renaming", async () => {
    expect(await create()).toMatchObject({id:"support-search",name:"support-search"});
    await expect(projects.create("admin",{name:"support search"})).rejects.toMatchObject({code:"project_exists"});
    await expect(database.pool.query("UPDATE project SET name='different' WHERE id='support-search'"))
      .rejects.toMatchObject({code:"23514"});
    expect((await database.pool.query("SELECT id,name FROM project WHERE id='support-search'")).rows[0])
      .toEqual({id:"support-search",name:"support-search"});
  });
  it("uses only the dedicated pool for its Project, while other Projects remain on default", async () => {
    const project = await create();
    expect((await routing.poolForProject(project.id)).poolId).toBe("default");
    expect(await dedicate(project.id)).toMatchObject({id:"support-search",name:"runner-support-search",projectId:project.id});
    expect((await routing.poolsForProject(project.id)).map(pool => pool.id)).toEqual(["support-search"]);
    expect((await routing.poolsForProject("projectA")).map(pool => pool.id)).toEqual(["default"]);
    await expect(dedicate(project.id)).rejects.toMatchObject({code:"runner_pool_exists"});
  });
  it("rejects wrong names, negative/padded ordinals and a different Project's name at registration", async () => {
    await dedicate((await create()).id);
    for (const id of ["runner-default-0","runner-support-search-01","runner-support-search--1","other-0"])
      await expect(registration(id,"support-search")).rejects.toMatchObject({status:422});
    await expect(registration("runner-support-search-0","support-search")).resolves.toBe(1);
    await expect(registration("runner-default-0","default")).resolves.toBe(1);
  });
  it("keeps the dedicated identity with the Project when its runtime group changes", async () => {
    const project = await create(); await dedicate(project.id);
    await admin(() => groups.create({id:"new-group",name:"New group"},"admin"));
    await admin(() => groups.assignProject(project.id,{groupId:"new-group",expectedGroupId:"default"},"admin"));
    expect(await routing.poolForProject(project.id)).toMatchObject({poolId:"support-search",groupId:"new-group"});
  });
  it("rejects unbound custom pools instead of offering a compatibility binding path", async () => {
    await expect(database.pool.query("INSERT INTO runner_pool(id,name,runtime_url) VALUES ('unbound','Unbound','http://unbound.invalid')")).rejects.toMatchObject({code:"23514"});
  });
});
