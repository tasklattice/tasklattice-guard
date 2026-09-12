/** Read-only preview against an existing Controller. No application data is changed. */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { z } from 'zod';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { ControlPlaneService } from '../server/services/control-plane.js';
const upstream = process.env.PREVIEW_CONTROLLER_URL ?? 'http://localhost:38081';
const pool = new Pool({connectionString:process.env.TEST_DATABASE_URL,max:2});
const service = Object.assign(Object.create(ControlPlaneService.prototype), {
  db:drizzle(pool), runtimeLogEncryptionKey:null, metricCache:new Map(),metricJobs:new Map(),
}) as ControlPlaneService;
const app = new Hono();
app.use('/api/*', async (c,next) => {
  if (c.req.method !== 'GET') return c.json({error:{message:'Read-only preview'}},405);
  if (c.req.path.startsWith('/api/v1/runtime-')) {
    const auth = await fetch(`${upstream}/api/auth/get-session`,{headers:{cookie:c.req.header('cookie')??''}});
    const session = await auth.json() as {user?:unknown};
    if (!session.user) return c.json({error:{message:'Sign in on the existing Controller first.'}},401);
  }
  await next();
});
app.get('/api/v1/telemetry/metrics', async c => c.json(await service.runtimeMetrics(z.object({window:z.enum(['1h','24h','7d','15d','30d']).default('24h'),guardrailId:z.string().optional(),routerId:z.string().optional()}).parse(c.req.query()))));
app.get('/api/v1/telemetry/endpoint-activity',async c=>c.json(await service.runtimeEndpointActivity()));
app.get('/api/v1/telemetry/events',async c=>c.json(await service.queryRuntimeEvents(z.object({limit:z.coerce.number().default(100),cursor:z.string().optional(),since:z.coerce.date().optional(),before:z.coerce.date().optional(),routerId:z.string().optional(),guardrailId:z.string().optional(),endpointId:z.string().optional(),requestId:z.string().optional(),direction:z.string().optional(),outcome:z.string().optional(),captured:z.enum(['true']).transform(()=>true).optional(),findingsOnly:z.enum(['true']).transform(()=>true).optional()}).parse(c.req.query()))));
app.get('/api/v1/telemetry/events/:id',async c=>c.json(await service.getRuntimeEvent(c.req.param('id'))));
app.get('/api/*',async c=>{
  const url=new URL(c.req.url);const response=await fetch(upstream+url.pathname+url.search,{headers:{cookie:c.req.header('cookie')??''},signal:AbortSignal.timeout(30_000)});
  return new Response(response.body,{status:response.status,headers:{'content-type':response.headers.get('content-type')??'application/json'}});
});
app.use('*',serveStatic({root:'./dist'}));
app.get('*',serveStatic({path:'./dist/index.html'}));
app.onError((error,c)=>{console.error(error.message);return c.json({error:{message:error.message}},500);});
const server=serve({fetch:app.fetch,port:38095,hostname:'127.0.0.1'},()=>console.log('Read-only preview: http://localhost:38095'));
const stop=()=>server.close(()=>{void pool.end().then(()=>process.exit());});
process.on('SIGTERM',stop);process.on('SIGINT',stop);
