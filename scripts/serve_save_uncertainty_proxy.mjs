/** Desktop acceptance fault: commit exactly one named draft, then lose its reply. */
import {createServer} from 'node:http';
import {readFileSync, existsSync, writeFileSync} from 'node:fs';
const path='/tmp/guard-tali-save-uncertainty-20260908.json';
const expectedName='Regression save outcome uncertain 20260908 tali';
const state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{expectedName,attempts:0,dropped:false};
const save=()=>writeFileSync(path,JSON.stringify(state,null,2)+'\n',{mode:0o600});
createServer(async(req,res)=>{
 try{
  const parts=[];for await(const part of req)parts.push(part);
  const body=Buffer.concat(parts);
  const target=req.method==='POST'&&req.url==='/api/v1/guardrails'&&JSON.parse(body).name===expectedName;
  if(target){state.attempts++;save();if(state.dropped){res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({error:'Acceptance proxy refuses a duplicate create. Check the existing Guardrail.'}));return;}}
  const headers={...req.headers,host:'localhost:38081'};delete headers['connection'];delete headers['accept-encoding'];
  if(headers.origin)headers.origin='http://localhost:38081';
  const reply=await fetch('http://localhost:38081'+req.url,{method:req.method,headers,...(body.length?{body}:{}),redirect:'manual'});
  const bytes=Buffer.from(await reply.arrayBuffer());
  if(target&&reply.status===201){const value=JSON.parse(bytes);state.committed={id:value.id,name:value.name,draftRevision:value.draftRevision,policyCount:value.draftConfig.policyBindings.length};state.dropped=true;save();res.destroy();console.log('Committed named draft; intentionally dropped its success response.');return;}
  const outgoing=Object.fromEntries(reply.headers);delete outgoing['content-encoding'];delete outgoing['transfer-encoding'];delete outgoing['content-length'];
  const cookies=reply.headers.getSetCookie();if(cookies.length)outgoing['set-cookie']=cookies;
  res.writeHead(reply.status,outgoing).end(bytes);
 }catch{if(!res.destroyed)res.writeHead(502).end('Acceptance forwarding error');}
}).listen(38091,'127.0.0.1',()=>console.log('Desktop save-uncertainty proxy on localhost:38091; only the named test draft is faulted.'));
