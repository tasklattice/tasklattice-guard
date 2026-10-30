"""Measure a disposable Deploy Dev report workload; never print Secrets or bodies."""
from __future__ import annotations
import argparse
import copy
import json
import subprocess
import threading
import time
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--context', default='orbstack')
parser.add_argument('--namespace', default='tali-report-bench')
parser.add_argument('--release', default='tali-guard-report-bench')
parser.add_argument('--reports', type=int, default=2000)
parser.add_argument('--cases', type=int, default=800)
parser.add_argument('--seconds', type=int, default=90)
parser.add_argument('--upload-delay-ms', type=int, default=0)
parser.add_argument('--output', type=Path, default=Path('output/report-memory-benchmark.json'))
args = parser.parse_args()
if args.context != 'orbstack' or not args.namespace.endswith('-report-bench') or not args.release.endswith('-report-bench'):
    raise SystemExit('Only an isolated local OrbStack *-report-bench deployment is allowed.')
kube = ['kubectl','--context',args.context,'-n',args.namespace]
def run(*command, data=None):
    result = subprocess.run([*kube,*command],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(f'kubectl {command[0]} failed (status {result.returncode}); no payload printed')
    return result.stdout

def resource(kind,name):
    return json.loads(run('get',kind,name,'-o','json'))

controller = resource('deployment',args.release+'-controller')
runner = resource('statefulset',args.release+'-runner')
pod = {'apiVersion':'v1','kind':'Pod','metadata':{'name':'report-memory-harness','labels':{'app.kubernetes.io/instance':args.release,'app.kubernetes.io/component':'runner','tasklattice.io/runner-pool':'report-memory-harness'}},'spec':copy.deepcopy(controller['spec']['template']['spec'])}
pod['spec']['restartPolicy']='Never'
pod['spec'].pop('initContainers',None)
container = pod['spec']['containers'][0]
container['name']='benchmark';container['command']=['sleep','3600'];container.pop('args',None)
for field in ('livenessProbe','readinessProbe','startupProbe','ports'): container.pop(field,None)
container['resources']={'requests':{'cpu':'100m','memory':'128Mi'},'limits':{'cpu':'2','memory':'1Gi'}}
tls = copy.deepcopy(next(v for v in runner['spec']['template']['spec']['volumes'] if v['name']=='control-tls'))
tls['name']='bench-tls';pod['spec']['volumes'].append(tls)
container.setdefault('volumeMounts',[]).append({'name':'bench-tls','mountPath':'/var/run/tasklattice/bench-tls','readOnly':True})
container.setdefault('env',[]).extend([{'name':'GUARD_BENCH_HOST','value':args.release+'-controller'},
    {'name':'GUARD_BENCH_REPORTS','value':str(args.reports)},{'name':'GUARD_BENCH_CASES','value':str(args.cases)},
    {'name':'GUARD_BENCH_SECONDS','value':str(args.seconds)}, {'name':'GUARD_BENCH_UPLOAD_DELAY_MS','value':str(args.upload_delay_ms)}])
samples=[]; failures=[]; measuring=threading.Event(); stop=threading.Event(); threads=[]
pods=json.loads(run('get','pods','-l',f'app.kubernetes.io/instance={args.release}','-o','json'))['items']
targets={p['metadata']['labels'].get('app.kubernetes.io/component'):p['metadata']['name'] for p in pods if p['status'].get('phase')=='Running'}
def sample(component,name):
    while not stop.is_set():
        if measuring.is_set():
            try:
                raw=run('exec',name,'-c',component,'--','cat','/sys/fs/cgroup/memory.current','/sys/fs/cgroup/memory.stat','/sys/fs/cgroup/memory.events').decode().splitlines()
                current=int(raw[0]); counters={key:int(value) for key,value in (line.split() for line in raw[1:])}
                samples.append({'component':component,'time':time.time(),'current':current,'working_set':current-counters.get('inactive_file',0),
                    'anon':counters.get('anon',0),'oom_kill':counters.get('oom_kill',0)})
            except Exception as error: failures.append(type(error).__name__)
        stop.wait(.5)

try:
    run('delete','pod','report-memory-harness','--ignore-not-found=true','--wait=true','--timeout=60s')
    run('apply','-f','-',data=json.dumps(pod).encode())
    run('wait','--for=condition=Ready','pod/report-memory-harness','--timeout=120s')
    run('exec','-i','report-memory-harness','--','sh','-c','cat > /tmp/report-memory-benchmark.mjs',data=Path(__file__).with_name('benchmark-report-memory.mjs').read_bytes())
    for component in ('controller','postgresql'):
        thread=threading.Thread(target=sample,args=(component,targets[component]),daemon=True);thread.start();threads.append(thread)
    process=subprocess.Popen([*kube,'exec','report-memory-harness','--','node','/tmp/report-memory-benchmark.mjs'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
    result=None
    for line in process.stdout:
        try: event=json.loads(line)
        except json.JSONDecodeError: continue
        if event.get('phase')=='load_start': measuring.set()
        if event.get('phase')=='complete': result=event
        print(json.dumps(event),flush=True)
    if process.wait()!=0 or result is None: raise RuntimeError('Benchmark failed; see sanitized phase output.')
    stop.set()
    for thread in threads:thread.join(timeout=5)
    result['memory']={component:{'samples':len(rows),'peak_current_bytes':max(row['current'] for row in rows),
        'peak_working_set_bytes':max(row['working_set'] for row in rows),'peak_anon_bytes':max(row['anon'] for row in rows),
        'oom_kills':max(row['oom_kill'] for row in rows),'baseline_working_set_bytes':rows[0]['working_set']}
        for component in ('controller','postgresql') if (rows:=[row for row in samples if row['component']==component])}
    result['sampling_errors']=len(failures)
    result['samples']=samples
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'phase':'memory_summary','memory':result['memory'],'sampling_errors':len(failures)}),flush=True)
finally:
    stop.set()
    for thread in threads:thread.join(timeout=5)
    run('delete','pod','report-memory-harness','--ignore-not-found=true','--wait=true','--timeout=60s')
