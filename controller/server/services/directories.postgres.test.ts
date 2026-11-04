// @vitest-environment node
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createTestDatabase} from '../db/postgres-test-database.js';
import {directoryQuerySchema} from '../../shared/directory.js';
import {UserDirectory} from './user-directory.js';
import {ProjectService} from './projects.js';
import {ProjectGroupService} from './project-groups.js';
import {RunnerDirectory} from './runner-directory.js';
import {runWithProjectContext} from './project-context.js';
import {calculatePoolCapacity} from '../domain/capacity.js';

const url=process.env.GUARD_TEST_POSTGRES_URL;
const page=(raw:unknown={})=>directoryQuerySchema.parse(raw);
describe.skipIf(!url)('bounded administration directories',()=>{
 let database:Awaited<ReturnType<typeof createTestDatabase>>;
 let users:UserDirectory;let projects:ProjectService;let groups:ProjectGroupService;let runners:RunnerDirectory;
 beforeAll(async()=>{
  database=await createTestDatabase(url!,'directory');users=new UserDirectory(database.db);projects=new ProjectService(database.db, async () => {});groups=new ProjectGroupService(database.db);runners=new RunnerDirectory(database.db,10);
  await database.pool.query(`
    INSERT INTO controller_state(id,desired_generation) VALUES ('singleton',0);
    INSERT INTO auth_user(id,name,email,username) SELECT 'user-'||lpad(i::text,3,'0'),'User '||i,'user'||i||'@example.test','user'||i FROM generate_series(1,61) i;
    INSERT INTO project(id,name) SELECT 'project-'||lpad(i::text,3,'0'),'project-'||lpad(i::text,3,'0') FROM generate_series(1,61) i;
    INSERT INTO project_member(project_id,user_id,source,access) SELECT id,'user-001','local','write' FROM project;
    INSERT INTO project_member(project_id,user_id,source,access) SELECT 'project-001',id,'local','write' FROM auth_user WHERE id<>'user-001';
    INSERT INTO auth_account(id,issuer,account_id,provider_id,user_id) VALUES ('sso-account','test-issuer','external','corporate-sso','user-061');
    INSERT INTO runner_pool(id,name,is_default) VALUES ('default','runner-default',true);
    INSERT INTO runner_instance(runner_id,boot_id,pool_id,runner_version,nemo_version,max_concurrency,status,load)
      SELECT 'runner-default-'||lpad(i::text,3,'0'),'boot-'||i,'default','test','test',8,case when i=60 then 'offline' else 'ready' end,
        '{"inflight":1,"queueDepth":0,"maxConcurrency":8,"requestsDelta":10,"observationIntervalMs":10000,"errorsDelta":1,"latencyP95Ms":50}'::jsonb FROM generate_series(0,60) i;
  `);
 },30000);
 afterAll(async()=>{await database?.drop();});
 it('lists 25 summaries and fetches bounded membership details only for the selected user',async()=>{
  const first=await users.list(page());expect(first.items).toHaveLength(25);expect(first.nextCursor).toBe('user-025');
  expect(first.items[0]).toMatchObject({id:'user-001',projectCount:64,source:'local'});
  expect(first.items[0]).not.toHaveProperty('projects');expect(first.items[0]).not.toHaveProperty('email');
  const second=await users.list(page({cursor:first.nextCursor}));expect(second.items).toHaveLength(25);expect(second.items[0]?.id).toBe('user-026');
  const last=await users.list(page({cursor:second.nextCursor}));expect(last.items).toHaveLength(11);expect(last.nextCursor).toBeNull();
  const detail=await users.detail('user-001',page());expect(detail.projects.items).toHaveLength(25);expect(detail.user).toHaveProperty('email');
  const next=await users.detail('user-001',page({cursor:detail.projects.nextCursor}));expect(next.projects.items[0]?.id).not.toBe(detail.projects.items[0]?.id);
  expect((await users.list(page({q:'user61'}))).items).toMatchObject([{id:'user-061',source:'sso'}]);
  expect((await users.list(page({q:'%'}))).items).toEqual([]);
 });
 it('pages projects, members and candidates independently without offering SSO identities locally',async()=>{
  const summaries=await projects.list(page());expect(summaries.items).toHaveLength(25);expect(summaries.items[0]).toMatchObject({memberCount:61,poolId:'default'});
  const members=await projects.members('project-001',page());expect(members.items).toHaveLength(25);expect(members.nextCursor).toBe('user-025');
  const candidates=await projects.memberCandidates('project-002',page({limit:100}));expect(candidates.items).toHaveLength(59);expect(candidates.items.some(user=>user.id==='user-061')).toBe(false);
  expect((await projects.memberCandidates('project-001',page())).items).toEqual([]);
 });
 it('rejects legacy identity overrides and binds dedicated pools at creation',async()=>{
  await expect(projects.create('user-001',{id:'old-id',name:'canonical'})).rejects.toThrow();
  expect(await projects.create('user-001',{name:' Search_Team '})).toMatchObject({id:'search-team',name:'search-team'});
  await runWithProjectContext({role:'admin',actorId:'user-001'},async()=>{
    await database.pool.query("UPDATE runner_instance SET status='offline'");
    const pool=await groups.createPool('default',{projectId:'search-team',runtimeUrl:'http://search:8091'},'user-001');
    await database.pool.query("UPDATE runner_instance SET status='ready' WHERE runner_id<>'runner-default-060'");
    expect(pool).toMatchObject({id:'search-team',name:'runner-search-team',projectId:'search-team'});
    await expect(groups.updateConnectivity(pool.id,{projectId:'project-002',runtimeUrl:'http://search:8091',publicUrl:null},'user-001')).rejects.toThrow();
  });
 });
 it('lists only group counts and fetches projects and pools separately',async()=>{
  await runWithProjectContext({role:'admin',actorId:'user-001'},async()=>{
    const list=await groups.list(page());expect(list.items[0]).toMatchObject({id:'default',projectCount:65,poolCount:2});
    expect(list).not.toHaveProperty('projects');expect(list.items[0]).not.toHaveProperty('projectIds');
    expect((await groups.pools('default',page({limit:1}))).items).toHaveLength(1);
  });
 });
 it('aggregates the entire Runner pool while paging instances and enforces Project visibility',async()=>{
  const list=await runners.list(page());expect(list.items.find(pool=>pool.id==='default')).toEqual({id:'default',name:'runner-default',totalCount:61,connectedCount:60});
  expect(list.items[0]).not.toHaveProperty('instances');
  const detail=await runners.detail('default',page());expect(detail.instances).toHaveLength(25);expect(detail.capacity.readyRunners).toBe(60);expect(detail.counts.total).toBe(61);
  const expected=calculatePoolCapacity(Array.from({length:61},(_,i)=>({status:i===60?'offline':'ready',inflight:1,maxConcurrency:8,queueDepth:0,cpuUtilization:0,memoryUtilization:0,requestsPerSecond:1,errorRate:.1,latencyP95Ms:50})),detail.safeRpsPerRunner,undefined,1.25,2);
  expect(detail.capacity).toEqual(expected);expect(detail.instances[0]).not.toHaveProperty('controlSessionId');
  const next=await runners.detail('default',page({cursor:detail.nextCursor}));expect(next.instances[0]?.runnerId).toBe('runner-default-025');expect(next.capacity).toEqual(detail.capacity);
  await runWithProjectContext({role:'user',projectId:'search-team'},async()=>{
    expect((await runners.list(page())).items.map(pool=>pool.id)).toEqual(['search-team']);
    await expect(runners.detail('default',page())).rejects.toMatchObject({code:'not_found'});
  });
 });
});
