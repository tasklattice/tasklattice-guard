"""Frozen-artifact acceptance Runner. No compiler, Controller DB, or real keys."""
import base64
import os
from pathlib import Path
from fastapi import FastAPI
import uvicorn
from runner import generated as protocol
from runner.api import RunnerAPI
from runner.artifact_store import ArtifactStore
from runner.metrics import RunnerMetrics
from runner.providers import dynamic_runtime_action_providers
from runner.toolkit.nemo.action_registry import action_providers
from runner.toolkit.nemo.registry import NeMoRuntimeRegistry
from runner.toolkit.nemo.runtime import NeMoRuntime
from runner.toolkit.runtime.context import CallContextStore
from runner.toolkit.runtime.service import GuardrailRuntimeService

fixture=Path(os.environ.get('ACCEPTANCE_FIXTURE', '/fixture'))
config=protocol.DataPlaneModelConfiguration(revision_id=os.environ.get('ACCEPTANCE_REVISION','tali-acceptance-20260908'),revision=1,
 runtimes=[protocol.ModelRuntime(id='safety',model='nvidia/llama-3.1-nemotron-safety-guard-8b-v3',
  profile_ref='tali.nemotron-safety-guard-v3.v1',credential_ref='bounded-gateway',timeout_seconds=45,max_tokens=1024,
  base_url=os.environ.get('ACCEPTANCE_GATEWAY','http://live-tali-acceptance-20260908.tali.svc.cluster.local:8097/nvidia/v1'))],
 bindings=[protocol.CapabilityBinding(binding_id='content_safety.'+phase,capability_ref='content_safety',
  rail_type=rail,implementation_ref='tali.runtime.safety-model.v1',model_ref='safety',
  profile_ref='tali.nemotron-safety-guard-v3.v1',contract_refs=['tali.guard.content-safety.v1'])
  for phase,rail in [('input',protocol.RAIL_TYPE_INPUT),('output',protocol.RAIL_TYPE_OUTPUT)]])
providers=action_providers(*dynamic_runtime_action_providers(config,{'bounded-gateway':'isolated-model-lifecycle-only'}))
store=ArtifactStore(fixture/'public-key.pem',Path('/state'))
registry=NeMoRuntimeRegistry(store,providers,max_concurrency_per_guardrail=1)
store.attach_registry(registry)
desired=protocol.DesiredState.FromString(base64.b64decode((fixture/'desired-state.pb.b64').read_text()))
desired.model_configuration.CopyFrom(config)
integration=desired.integrations.add();integration.CopyFrom(desired.integrations[0]);integration.integration_id='quality-integration';integration.adapter='generic-http-guard'
route=desired.deployments.add();route.CopyFrom(desired.deployments[0]);route.integration_id='quality-integration';route.deployment_id='quality-deployment'
store.apply(desired)
engine=NeMoRuntime(registry)
class Telemetry:
 async def emit(self,event): pass
app=FastAPI()
app.include_router(RunnerAPI(GuardrailRuntimeService(engine,store,contexts=CallContextStore()),store,
 RunnerMetrics(4),Telemetry(),'tali-acceptance','synthetic-acceptance-controller').router)
@app.get('/health')
def health():
 return {'ready':registry.readiness()['ready'],'model_revision_id':config.revision_id,'scope':'frozen-artifact acceptance, not main configuration activation'}
uvicorn.run(app,host='0.0.0.0',port=int(os.environ.get('ACCEPTANCE_PORT','8096')),access_log=False,log_level='warning')
