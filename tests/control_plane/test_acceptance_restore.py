"""Acceptance cleanup decisions must preserve unrelated and still-active revisions."""
import json
from pathlib import Path
import subprocess
import pytest

ROOT=Path(__file__).resolve().parents[2]

@pytest.mark.parametrize('view,expected', [
    ({'active':{'id':'original'},'failed':{'id':'attempt'}}, 'unchanged'),
    ({'active':{'id':'attempt'}}, 'rollback'),
    ({'active':{'id':'original'},'activating':{'id':'attempt'}}, 'wait'),
    ({'active':{'id':'original'},'activating':{'id':'someone-else'}}, 'refused'),
    ({'active':{'id':'someone-else'}}, 'refused'),
    ({'active':None}, 'refused'),
])
def test_restore_does_not_mutate_unrelated_or_unchanged_configuration(view, expected):
    source='''import {restoreAction} from './scripts/model_activation_state.mjs';
      try { console.log(restoreAction(JSON.parse(process.argv[1]), 'original', 'attempt')); }
      catch { console.log('refused'); }'''
    result=subprocess.run(['node','--input-type=module','-e',source,json.dumps(view)],cwd=ROOT,
        capture_output=True,text=True,check=True,timeout=10)
    assert result.stdout.strip()==expected

@pytest.mark.parametrize('view,expected', [
    ({'active':{'id':'old'},'activating':{'id':'replacement'}},'replacement'),
    ({'active':{'id':'replacement'},'activating':None},'replacement'),
    ({'id':'not-a-public-view'},'refused'),
])
def test_activation_result_uses_public_view_contract(view, expected):
    source='''import {activationRevisionId} from './scripts/model_activation_state.mjs';
      try { console.log(activationRevisionId(JSON.parse(process.argv[1]))); }
      catch { console.log('refused'); }'''
    result=subprocess.run(['node','--input-type=module','-e',source,json.dumps(view)],cwd=ROOT,
        capture_output=True,text=True,check=True,timeout=10)
    assert result.stdout.strip()==expected
