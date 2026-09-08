// Test-only, same dev image, signed frozen artifacts; no compiler or real keys.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const name='tali-expanded-runner-20260908';
const kubectl=args=>execFileSync('kubectl',['--context','orbstack','-n','tali',...args],{encoding:'utf8'});
assert(!kubectl(['get','deployment',name,'--ignore-not-found','-o','name']).trim(),'Inspect an existing run rather than recreate it.');
const modes=['inout','full_buffered','window_buffered','interruptible'];
const data={'serve.py':readFileSync('scripts/serve_tali_acceptance_runner.py','utf8')};
const items=[];
for(const mode of modes){
 const folder=mode==='inout'?'content-safety-inout-v1':`stream-safety-${mode}-v1`;
 for(const file of ['public-key.pem','desired-state.pb.b64']){
  const key=mode+'-'+file;data[key]=readFileSync(`tests/fixtures/artifacts/${folder}/${file}`,'utf8');
  items.push({key,path:mode+'/'+file});
 }
}
items.push({key:'serve.py',path:'serve.py'});
const resources=[{apiVersion:'v1',kind:'ConfigMap',metadata:{name},data},
 {apiVersion:'apps/v1',kind:'Deployment',metadata:{name},spec:{replicas:1,selector:{matchLabels:{app:name}},template:{metadata:{labels:{app:name}},spec:{
 automountServiceAccountToken:false,
 containers:modes.map((mode,i)=>({name:mode.replaceAll('_','-'),image:'ghcr.io/tasklattice/tali-guard-runner:dev',imagePullPolicy:'Never',
 command:['python','/fixture/serve.py'],env:[
 {name:'PYTHONPATH',value:'/opt/tasklattice/guard-runner'},
 {name:'ACCEPTANCE_FIXTURE',value:'/fixture/'+mode},
 {name:'ACCEPTANCE_PORT',value:String(8096+i)},
 {name:'ACCEPTANCE_REVISION',value:'tali-expanded-20260908'},
 {name:'ACCEPTANCE_GATEWAY',value:'http://live-tali-expanded-20260908.tali.svc.cluster.local:8097/nvidia/v1'}],
 readinessProbe:{httpGet:{path:'/health',port:8096+i}},
 resources:{requests:{cpu:'100m',memory:'256Mi'},limits:{cpu:'2',memory:'2Gi'}},
 volumeMounts:[{name:'fixture',mountPath:'/fixture',readOnly:true},{name:'state-'+i,mountPath:'/state'}]})),
 volumes:[{name:'fixture',configMap:{name,items}},...modes.map((_,i)=>({name:'state-'+i,emptyDir:{}}))]
 }}}}];
execFileSync('kubectl',['--context','orbstack','-n','tali','apply','-f','-'],{input:JSON.stringify({apiVersion:'v1',kind:'List',items:resources}),stdio:['pipe','inherit','inherit']});
