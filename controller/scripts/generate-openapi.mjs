// Generate from the actual Hono handlers, their Zod parsers and TypeScript response types.
// This runs at build time only; it never starts the app or connects to a database.
import { API, TypeFlags as F, SymbolFlags } from 'typescript/unstable/sync';
import * as ast from 'typescript/unstable/ast';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { apiTags, operationContract } from '../shared/api-contract.ts';
import SwaggerParser from '@apidevtools/swagger-parser';
import { GUARD_AUTH_COOKIE_PREFIX } from '../server/auth.ts';
import { tokenRoutePermissions } from '../server/http/token-permissions.ts';
import { createAccessTokenSchema } from '../shared/access-tokens.ts';
import { assignmentInputSchema, modelConfigurationInputSchema } from '../server/model-config/domain.ts';
import { MAX_DOCUMENTS, MAX_DOCUMENT_BYTES, MAX_TOTAL_BYTES } from '../server/control-plane-ai/document-ingestion.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'openapi/controller.openapi.json');
const api = new API({ cwd: root });
const temp = resolve(root, `scripts/.openapi-inputs-${process.pid}.ts`);
const nodes = root => { const result = []; function visit(node) { result.push(node); node.forEachChild(visit); } visit(root); return result; };
const assert = (value, message) => { if (!value) throw new Error(message); return value; };
const camel = text => text.replace(/[^a-zA-Z0-9]+(.)/g, (_, letter) => letter.toUpperCase());
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const ref = name => ({ $ref: `#/components/schemas/${name}` });

try {
  const snapshot = api.updateSnapshot({ openProjects: [resolve(root, 'tsconfig.server.json')] });
  const project = snapshot.getProject(resolve(root, 'tsconfig.server.json'));
  const checker = project.checker;
  const source = project.program.getSourceFile(resolve(root, 'server/http/app.ts'));
  const allNodes = nodes(source);
  const calls = allNodes.filter(ast.isCallExpression);
  const routes = calls.filter(n => ast.isPropertyAccessExpression(n.expression) && n.expression.expression.getText() === 'app' && ['get','post','put','patch','delete'].includes(n.expression.name.text)
    && ast.isStringLiteral(n.arguments[0]) && n.arguments[0].text.startsWith('/api/v1/'));
  const entries = routes.map(route => {
    const method = route.expression.name.text.toUpperCase(); const path = route.arguments[0].text;
    const handler = route.arguments.at(-1);
    assert(ast.isArrowFunction(handler) || ast.isFunctionExpression(handler), `Unsupported handler: ${method} ${path}`);
    return { method, path, handler, nodes: nodes(handler), id: camel(`${method.toLowerCase()} ${path.replace('/api/v1/','').replace(/:/g,'by ')}`), middleware: route.arguments.slice(1,-1).map(n=>n.getText()) };
  });
  // Evaluate only schema declarations and their imports, never HTTP handlers. Any parser
  // referencing handler-local data will fail generation rather than publish a guessed schema.
  const createApp = source.statements.find(s => ast.isFunctionDeclaration(s) && s.name?.text === 'createHttpApp');
  const imports = source.statements.filter(n => ast.isImportDeclaration(n) && n.moduleSpecifier.text !== './openapi.js').map(n => {
    const specifier = n.moduleSpecifier.text;
    return n.getText().replace(n.moduleSpecifier.getText(), JSON.stringify(specifier.startsWith('.') ? resolve(dirname(source.fileName),specifier) : specifier));
  });
  const declarations = source.statements.filter(n => n.end < createApp.pos && !ast.isImportDeclaration(n)).map(n=>n.getText());
  const distribution = allNodes.find(n => ast.isVariableDeclaration(n) && n.name.getText() === 'distributionQuery');
  if (distribution) declarations.push(`const distributionQuery = ${distribution.initializer.getText()};`);
  const parsers = [];
  for (const route of entries) {
    route.parsers = [];
    for (const n of route.nodes.filter(ast.isCallExpression)) {
      if (!ast.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'parse') continue;
      const argument = n.arguments[0]?.getText() ?? '';
      if (!/context\.req\.(json|query|param)|JSON\.parse/.test(argument)) continue;
      const receiver = n.expression.expression.getText();
      const key = `schema${parsers.length}`;
      parsers.push(`${key}: ${receiver}`);
      route.parsers.push({ key, receiver, argument });
    }
  }
  await writeFile(temp, `${imports.join('\n')}\n${declarations.join('\n')}\nexport const schemas = {${parsers.join(',\n')}};\n`);
  const { schemas: inputs } = await import(pathToFileURL(temp).href);
  const components = {};
  function inputSchema(schema, name) {
    const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12', unrepresentable: 'any', override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema._zod.def.type === 'date') Object.assign(jsonSchema, { type: 'string', format: 'date-time' });
      if (zodSchema._zod.def.checks?.some(check => check._zod.def.check === 'custom')) jsonSchema['x-runtime-validation'] = 'Additional runtime refinements apply; JSON Schema validation alone does not guarantee acceptance.';
    } });
    delete json.$schema;
    // Zod's recursive references are rooted in the standalone schema; relocate them
    // when embedding it inside the OpenAPI components object.
    function relocate(value) { if (!value || typeof value !== 'object') return; if (value.$ref?.startsWith('#')) value.$ref = `#/components/schemas/${name}${value.$ref.slice(1)}`; Object.values(value).forEach(relocate); }
    relocate(json); components[name] = json; return ref(name);
  }
  const typeNames = new Map();
  function responseSchema(type, hint, depth = 0) {
    assert(type && !type.isErrorType(), `Unresolved response type at ${hint}`);
    const flags = type.flags;
    if (flags & (F.Any | F.Unknown)) return { description: 'Application-defined JSON value.' };
    if (flags & (F.Undefined | F.Void | F.Never)) return false;
    if (flags & F.Null) return { type: 'null' };
    if (flags & (F.StringLiteral | F.NumberLiteral | F.BooleanLiteral)) return { type: typeof type.value, const: type.value };
    if (flags & (F.String | F.TemplateLiteral | F.StringMapping)) return { type: 'string' };
    if (flags & F.Number) return { type: 'number' };
    if (flags & F.Boolean) return { type: 'boolean' };
    if (type.isUnionType()) {
      const choices = type.getTypes().filter(t => !(t.flags & (F.Undefined | F.Void | F.Never)));
      if (choices.every(t => t.isLiteralType())) {
        const values = [...new Set(choices.map(t=>t.value))];
        return { ...(new Set(values.map(v=>typeof v)).size === 1 ? {type:typeof values[0]} : {}), enum: values };
      }
      const variants = choices.map(t=>responseSchema(t,hint,depth+1));
      return variants.length === 1 ? variants[0] : { anyOf: variants };
    }
    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const args = checker.getTypeArguments(type);
      if (checker.isTupleType(type)) return { type: 'array', prefixItems: args.map((t,i)=>responseSchema(t,`${hint}Item${i}`,depth+1)), minItems: args.length, maxItems: args.length };
      return { type: 'array', items: responseSchema(args[0],`${hint}Item`,depth+1) };
    }
    if (type.getSymbol()?.name === 'Date') return { type: 'string', format: 'date-time' };
    assert(!(flags & (F.BigInt | F.BigIntLiteral | F.ESSymbol | F.UniqueESSymbol)), `Non-JSON response at ${hint}: ${checker.typeToString(type)}`);
    if (typeNames.has(type.id)) return ref(typeNames.get(type.id));
    assert(depth < 80, `Response type recursion limit at ${hint}`);
    let name = hint.replace(/[^a-zA-Z0-9_]/g,''); let suffix=2; while (components[name]) name = `${hint}${suffix++}`;
    typeNames.set(type.id,name); components[name] = {};
    const properties = {}; const required = [];
    for (const symbol of checker.getPropertiesOfType(type)) {
      if (symbol.name.startsWith('__@')) continue;
      const propertyType = checker.getTypeOfSymbol(symbol);
      const schema = responseSchema(propertyType,`${name}${symbol.name[0].toUpperCase()}${symbol.name.slice(1)}`,depth+1);
      if (schema === false) continue;
      properties[symbol.name] = schema;
      if (!(symbol.flags & SymbolFlags.Optional) && !(propertyType.flags & F.Undefined) && !(propertyType.isUnionType() && propertyType.getTypes().some(t=>t.flags & F.Undefined))) required.push(symbol.name);
    }
    const indices = checker.getIndexInfosOfType(type);
    assert(Object.keys(properties).length || indices.length || checker.typeToString(type) === '{}', `Unrepresentable response ${name}: ${checker.typeToString(type)}`);
    components[name] = { type: 'object', ...(Object.keys(properties).length ? {properties, ...(required.length ? {required} : {})} : {}), ...(indices.length ? { additionalProperties: responseSchema(indices[0].valueType,`${name}Value`,depth+1) } : {}) };
    return ref(name);
  }
  const paths = {};
  const errorSchema = { type:'object', required:['error'], properties:{error:{type:'object',required:['code','message'],properties:{code:{type:'string'},message:{type:'string'},detail:{description:'Validation details or domain error context.'}}}} };
  components.Error = errorSchema;
  const statusDescription = {200:'Successful response.',201:'Resource created.',202:'Accepted for asynchronous processing; this does not guarantee deployment or completion.',204:'Successful response with no body.',400:'Request schema validation failed.',401:'Missing, invalid, expired or revoked credential.',403:'Insufficient token permission, account role, or session requirement.',404:'Resource not found.',409:'State conflict; reload and review before retrying.',415:'Unsupported content type.',422:'Domain validation failed.',500:'Internal server error.',503:'Required service or runtime is unavailable.'};
  const bodyOverrides = new Map([
    ['POST /api/v1/account/access-tokens',createAccessTokenSchema],
    ['PUT /api/v1/models/:id/protocol',modelConfigurationInputSchema],
    ['PUT /api/v1/model-configuration/draft',assignmentInputSchema],
  ]);
  for (const route of entries) {
    const {id,method,path,middleware} = route; const template = path.replace(/:([^/]+)/g,'{$1}');
    const permission = tokenRoutePermissions.find(([m,p])=>m===method && p===path);
    const sessionOnly = middleware.includes('accountSession'); const authenticated = middleware.includes('authenticated');
    assert(!authenticated || permission || sessionOnly || path === '/api/v1/account/identity', `Missing token policy: ${method} ${path}`);
    const role = middleware.includes('administrator') ? 'admin' : 'user';
    const operation = { operationId:id, summary: `${method} ${template}`, tags:[sessionOnly || path==='/api/v1/account/identity' ? 'Account' : permission?.[2] ?? 'System'],
      description: permission ? `Requires ${permission[2]}:${permission[3]} for personal access tokens. ${permission[3]==='write' ? 'Write includes read access and requires a current administrator account. ' : ''}${role==='admin' ? 'This operation also requires the admin account role. ' : ''}Token access covers all resources in the selected module.` : sessionOnly ? 'Browser session only. Personal access tokens cannot manage credentials. Ownership is taken from the authenticated session.' : path==='/api/v1/account/identity' ? 'Returns the authenticated identity and token permissions. Effective permissions are capped by the current account role.' : 'Public system health information; no credential is required.',
      security: authenticated ? sessionOnly ? [{sessionCookie:[]}] : [{personalAccessToken:[]},{sessionCookie:[]}] : [],
      ...(permission ? {'x-token-permission':{module:permission[2],access:permission[3]}} : {}),
      'x-account-role':role, ...(permission ? {'x-token-account-role':permission[3]==='write' ? 'admin' : role} : {}), 'x-source':`server/http/app.ts#${source.getLineAndCharacterOfPosition(route.handler.pos).line+1}`,
      parameters:[], responses:{} };
    const semantics = operationContract(method, path);
    Object.assign(operation, semantics, { description: `${semantics.description} ${operation.description}` });
    for (const match of path.matchAll(/:([^/]+)/g)) operation.parameters.push({name:match[1],in:'path',required:true,schema:{type:'string'}});
    for (const parser of route.parsers) {
      const schema = inputs[parser.key];
      const single = /context\.req\.(query|param)\(['"]([^'"]+)['"]\)/.exec(parser.argument);
      const name = `${id}${single ? camel(` ${single[1]} ${single[2]}`) : parser.argument.includes('context.req.query()') ? 'Query' : 'Request'}`;
      const converted = inputSchema(schema,name); const json=components[name];
      if (single) {
        const location=single[1]==='param'?'path':'query';
        const parameter={name:single[2],in:location,required:location==='path'||!schema.safeParse(undefined).success,schema:converted};
        operation.parameters=operation.parameters.filter(p=>p.in!==location||p.name!==single[2]); operation.parameters.push(parameter);
      } else if (parser.argument.includes('context.req.query()')) {
        assert(json.properties,`Query must be an object: ${id}`);
        for(const [name,property] of Object.entries(json.properties)) operation.parameters.push({name,in:'query',required:json.required?.includes(name)??false,schema:property});
      } else {
        assert(!operation.requestBody,`Multiple JSON body parsers: ${id}`);
        const optional = route.nodes.some(n=>ast.isCallExpression(n)&&n.expression.getText()==='context.req.text');
        operation.requestBody={required:!optional,content:{'application/json':{schema:converted}}};
      }
    }
    for (const call of route.nodes.filter(ast.isCallExpression)) {
      if (call.expression.getText()==='context.req.query' && call.arguments[0] && ast.isStringLiteral(call.arguments[0]) && !operation.parameters.some(p=>p.in==='query'&&p.name===call.arguments[0].text))
        operation.parameters.push({name:call.arguments[0].text,in:'query',required:false,schema:{type:'string'},...(call.arguments[0].text==='endpointIds'?{description:'Comma-separated Endpoint IDs.'}:{})});
    }
    if (bodyOverrides.has(`${method} ${path}`)) operation.requestBody={required:true,content:{'application/json':{schema:inputSchema(bodyOverrides.get(`${method} ${path}`),`${id}Body`)}}};
    const hasBody = route.nodes.some(n=>ast.isCallExpression(n)&&['context.req.json','context.req.text'].includes(n.expression.getText()));
    assert(!hasBody||operation.requestBody,`Undocumented request body: ${id}`);
    if (route.nodes.some(n=>ast.isCallExpression(n)&&n.expression.getText()==='context.req.formData')) {
      assert(path==='/api/v1/authoring/document-analyses',`Undocumented multipart body: ${id}`);
      operation.requestBody={required:true,content:{'multipart/form-data':{schema:{type:'object',required:['files'],properties:{language:{type:'string',enum:['en','zh-CN'],default:'en'},files:{type:'array',minItems:1,maxItems:MAX_DOCUMENTS,items:{type:'string',format:'binary'},description:`DOC, DOCX or TXT; each file <= ${MAX_DOCUMENT_BYTES} bytes; combined <= ${MAX_TOTAL_BYTES} bytes.`}}}}}};
    }
    for(const call of route.nodes.filter(ast.isCallExpression)) {
      if(!['context.json','context.body'].includes(call.expression.getText()))continue;
      const statusType=call.arguments[1] ? checker.getTypeAtLocation(call.arguments[1]) : null;
      const statuses=statusType ? (statusType.isUnionType()?statusType.getTypes():[statusType]).map(t=>t.value) : [200];
      assert(statuses.every(s=>Number.isInteger(s)&&s>=100&&s<=599),`Dynamic response status: ${id}`);
      for(const status of statuses){
        const response={description:statusDescription[status]??`HTTP ${status}.`};
        if(status!==204){
          assert(call.expression.getText()==='context.json',`Non-JSON response ${id}`);
          const dataType=checker.getTypeAtLocation(call.arguments[0]);
          assert(!(dataType.flags & (F.Any|F.Unknown)),`Untyped response body ${id}`);
          const schema=responseSchema(dataType,`${id}Response`);
          const previous=operation.responses[status]?.content?.['application/json']?.schema;
          response.content={'application/json':{schema:previous&&JSON.stringify(previous)!==JSON.stringify(schema)?{anyOf:[previous,schema]}:schema}};
        }
        operation.responses[status]=response;
      }
    }
    assert(Object.keys(operation.responses).some(code=>Number(code)<400),`No success response: ${id}`);
    for(const status of [400,404,409,422,500,503,...(authenticated?[401,403]:[]),...(sessionOnly?[415]:[])])
      operation.responses[status]??={description:statusDescription[status],content:{'application/json':{schema:ref('Error')}}};
    operation.responses.default={description:'Other Controller or upstream failure. Inspect error.code and error.message before deciding whether to retry.',content:{'application/json':{schema:ref('Error')}}};
    if(sessionOnly || path==='/api/v1/account/identity') for(const [status,response] of Object.entries(operation.responses).filter(([status])=>Number(status)<400)) response.headers={'Cache-Control':{schema:{type:'string',const:'no-store'},description:'Credentials and identity responses must not be cached.'}};
    if(!operation.parameters.length)delete operation.parameters;
    paths[template]??={}; assert(!paths[template][method.toLowerCase()],`Duplicate operation ${id}`); paths[template][method.toLowerCase()]=operation;
  }
  const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
  const document={openapi:'3.1.0',info:{title:'TaskLattice Guard Controller API',version:pkg.version,description:'Generated from Hono handlers, runtime Zod schemas, TypeScript JSON response types, and the token permission allowlist. Personal tokens use Authorization: Bearer <token>. Never put tokens in URLs. A supplied invalid credential does not fall back to a browser cookie. Runner data-plane and internal control APIs, metrics, and Better Auth endpoints are separate contracts.'},servers:[{url:'/',description:'The Controller serving this document.'}],tags:apiTags,paths,components:{securitySchemes:{personalAccessToken:{type:'http',scheme:'bearer',bearerFormat:'tlg_pat_<opaque-secret>',description:'Personal access token; module permissions and current account role both apply.'},sessionCookie:{type:'apiKey',in:'cookie',name:`${GUARD_AUTH_COOKIE_PREFIX}.session_token`,description:'Better Auth browser session. Production deployments may use the __Secure- cookie prefix.'}},schemas:components}};
  await SwaggerParser.validate(structuredClone(document));
  const text=JSON.stringify(stable(document),null,2)+'\n';
  if(process.argv.includes('--check'))assert(await readFile(output,'utf8')===text,'OpenAPI document is stale. Run npm run openapi:generate and commit the generated artifact.');
  else {await mkdir(dirname(output),{recursive:true});await writeFile(output,text);}
  console.log(`${process.argv.includes('--check')?'Checked':'Generated'} ${entries.length} operations and ${Object.keys(components).length} schemas: openapi/controller.openapi.json`);
} finally { api.close(); await rm(temp,{force:true}); }
