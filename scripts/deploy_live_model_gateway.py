"""Create the explicitly isolated, bounded model-e2e recorder. Never print keys."""
import json
import argparse
from pathlib import Path
import subprocess
from model_response_gateway import load_credentials

NAMESPACE = 'tali-model-e2e'
LAUNCHER = '''
import time
from pathlib import Path
from fastapi.responses import JSONResponse
import uvicorn
from model_response_gateway import Recorder, create_app, load_credentials, MODELS, ROUTES
MODELS['nvidia'] = {'nvidia/llama-3.1-nemotron-safety-guard-8b-v3'}
ROUTES.pop('nvidia/v1/classify')
recorder = Recorder(Path('/records/live.sqlite'), 40)
app = create_app(recorder, live=True, credentials=load_credentials(Path('/credentials/keys.env')))
deadline = time.monotonic() + 1800
@app.middleware('http')
async def boundary(request, call_next):
    if request.url.path != '/health':
        if time.monotonic() > deadline:
            return JSONResponse({'error':'Live test time window closed'}, status_code=503)
        if request.headers.get('authorization') != 'Bearer isolated-model-lifecycle-only':
            return JSONResponse({'error':'Isolated test credential required'}, status_code=401)
    return await call_next(request)
uvicorn.run(app, host='0.0.0.0', port=8097, access_log=False, log_level='warning')
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--name', choices=['live-model-gateway', 'live-stream-model-gateway', 'live-stream-model-gateway-round2', 'live-tali-acceptance-20260908', 'live-tali-expanded-20260908'], default='live-model-gateway')
    parser.add_argument('--namespace', choices=['tali-model-e2e', 'tali'], default=NAMESPACE)
    parser.add_argument('--limit', type=int, choices=[30, 40, 100], default=40)
    args = parser.parse_args()
    name = args.name
    namespace = args.namespace
    expanded = name == 'live-tali-expanded-20260908'
    main_run = name == 'live-tali-acceptance-20260908' or expanded
    if (namespace == 'tali') != main_run or (main_run and args.limit != (100 if expanded else 40)):
        raise SystemExit('Use the dedicated namespace, run name and authorized cap.')
    launcher = LAUNCHER.replace("Recorder(Path('/records/live.sqlite'), 40)", f"Recorder(Path('/records/live.sqlite'), {args.limit})")
    if expanded:
        launcher = launcher.replace('time.monotonic() + 1800', 'time.monotonic() + 10800')
    if name.endswith('-round2') or main_run:
        if not main_run and args.limit != 30:
            raise SystemExit('Round 2 is authorized for 30 detector calls only.')
        launcher = launcher.replace("ROUTES.pop('nvidia/v1/classify')", "ROUTES.pop('nvidia/v1/classify')\nfor route in list(ROUTES):\n    if route.startswith('deepseek/'):\n        ROUTES.pop(route)")
    # Never reset the budget of an existing gateway by redeploying it.
    existing = subprocess.run(['kubectl', '--context', 'orbstack', '-n', namespace,
        'get', 'deployment', name, '--ignore-not-found', '-o', 'name'], capture_output=True, text=True, check=True)
    if existing.stdout.strip():
        raise SystemExit('Gateway exists; inspect its budget and state instead of recreating it.')
    credentials = load_credentials(Path('.env'))
    if not all(credentials.values()) or any('\n' in value for value in credentials.values()):
        raise SystemExit('Both valid single-line credentials are required.')
    key_file = '\n'.join(f'{key}={credentials[provider]}' for provider, key in [
        ('deepseek', 'MODEL_GUARDRAILS_CONTROL_PLANE_AI_API_KEY_ENV_VAR'), ('nvidia', 'MODEL_GUARDRAILS_NVIDIA_API_KEY_ENV_VAR')])
    resources = [
        {'apiVersion':'v1','kind':'Secret','metadata':{'name':'live-model-gateway-keys'},'stringData':{'keys.env':key_file}},
        {'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'live-model-gateway-code'},'data':{
            'model_response_gateway.py':Path('scripts/model_response_gateway.py').read_text(), 'launch.py':launcher}},
        {'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'live-model-gateway'},'spec':{
            'replicas':1,'selector':{'matchLabels':{'app':'live-model-gateway'}},'template':{
                'metadata':{'labels':{'app':'live-model-gateway'}},'spec':{'automountServiceAccountToken':False,
                    'containers':[{'name':'gateway','image':'ghcr.io/tasklattice/tali-guard-runner:dev','imagePullPolicy':'Never',
                        'command':['python','/code/launch.py'],'ports':[{'containerPort':8097,'name':'http'}],
                        'readinessProbe':{'httpGet':{'path':'/health','port':8097}},
                        'resources':{'requests':{'cpu':'50m','memory':'64Mi'},'limits':{'cpu':'1','memory':'256Mi'}},
                        'volumeMounts':[{'name':n,'mountPath':'/'+p,'readOnly':n!='records'} for n,p in
                            [('code','code'),('keys','credentials'),('records','records')]]}],
                    'volumes':[{'name':'code','configMap':{'name':'live-model-gateway-code'}},
                        {'name':'keys','secret':{'secretName':'live-model-gateway-keys'}},{'name':'records','emptyDir':{}}]}}}},
        {'apiVersion':'v1','kind':'Service','metadata':{'name':'live-model-gateway'},'spec':{
            'selector':{'app':'live-model-gateway'},'ports':[{'port':8097,'targetPort':8097}]}},
        {'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'live-model-gateway-ingress'},
            'spec':{'podSelector':{'matchLabels':{'app':'live-model-gateway'}},'policyTypes':['Ingress'],
                'ingress':[{'from':[{'podSelector':{}}],'ports':[{'protocol':'TCP','port':8097}]}]}},
    ]
    # Rename resource references, never credential values, for a separate bounded run.
    def rename(value):
        if isinstance(value, dict):
            return {key: child if key == 'stringData' else rename(child) for key, child in value.items()}
        if isinstance(value, list):
            return [rename(child) for child in value]
        if isinstance(value, str) and value.startswith('live-model-gateway'):
            return name + value[len('live-model-gateway'):]
        return value
    resources = rename(resources)
    if main_run:
        # Preserve reservations across Pod recreation; a new Pod must not reset spend.
        resources.append({'apiVersion':'v1','kind':'PersistentVolumeClaim','metadata':{'name':name+'-records'},
            'spec':{'accessModes':['ReadWriteOnce'],'resources':{'requests':{'storage':'64Mi'}}}})
        pod = next(r for r in resources if r['kind'] == 'Deployment')['spec']['template']['spec']
        pod['securityContext'] = {'fsGroup':65532}
        pod['volumes'][-1] = {'name':'records','persistentVolumeClaim':{'claimName':name+'-records'}}
    subprocess.run(['kubectl','--context','orbstack','-n',namespace,'apply','-f','-'],
        input=json.dumps({'apiVersion':'v1','kind':'List','items':resources}),text=True,check=True)


if __name__ == '__main__':
    main()
