from pathlib import Path
import json
policies={p['id']:p for p in json.loads(Path('runner/toolkit/policy_library/assets/policies.json').read_text())}

# Authored execution order: inspect harmful intent before redacting its evidence.
# This is Profile configuration, not a compiler-wide Block-first rewrite.
POLICY_ORDER = [
 'credentials-secrets','prompt-instruction-attacks','application-injection','content-filters',
 'content-safety-local','professional-advice','financial-market-misconduct','fraud-account-abuse',
 'regional-compliance-eu-ai-act','regional-compliance-uae-content-standards','regional-compliance-sg-pdpa',
 'business-topics','content-safety-model','payment-data','identity-documents','contact-data',
 'network-identifiers','sensitive-attributes','risk-content-terms','pii-semantic','answer-reliability',
]
RULE_ORDER = {
 'payment-data': ['financial-pii/visa','financial-pii/mastercard','financial-pii/amex','financial-pii/discover','pattern/eu_iban_enhanced'],
 'identity-documents': ['identity/passport','pattern/uoft_student_id'],
 'contact-data': ['pattern/uae_phone','pattern/fr_phone'],
}


def ordered(ids):
 return sorted(ids, key=lambda pid: POLICY_ORDER.index(pid) if pid in POLICY_ORDER else len(POLICY_ORDER))

def policy_selection(ids, local_only=False):
 out=[]
 for pid in ids:
  p=policies[pid]
  rules=[r for r in p['rules'] if (not local_only or r['implementation']['execution'] == 'local')
   and r['detector']['ref'] != 'service/formal-verification']
  if not rules: continue
  first=RULE_ORDER.get(pid, [])
  rules.sort(key=lambda r: first.index(r['id']) if r['id'] in first else len(first))
  params={}
  testing=p.get('testing',{})
  for param in p['parameters']:
   value=testing.get(param['name'], param.get('default'))
   if value is None or str(value).strip()=='': value='PROFILE_PLACEHOLDER'
   params[param['name']]=value
  rails=sorted({rail for r in rules for rail in r['rails']})
  out.append({'policyId':pid,'policyVersion':p['version'],'enabledRails':rails,'parameterValues':params,
   'action':None,'ruleActions':{},'reasoningPolicy':None,'enabledRuleIds':[r['id'] for r in rules],
   'ruleOrder':[r['id'] for r in rules],'testCaseOverrides':{}})
 return out

def profile(pid,name,industry,jurisdictions,policies_ids,local_only=False,benchmark=False,desc=''):
 return {'id':pid,'version':'1.1.1' if pid == 'full-feature' else '1.1.0','name':name,'description':desc,'industry':industry,'jurisdictions':jurisdictions,
  'benchmarkOnly':benchmark,'policies':policy_selection(ordered(policies_ids),local_only),'parameterPacks':[],
  'draftSettings':{'allowedTopics':[],'restrictedTopics':[],'topicControlMode':'strict','safetyLevel':'balanced','outputDelivery':'full_buffered'},
  'suggestedTopics':[],'optionalPolicyIds':[],'limitations':[]}
all_ids=list(policies)
profiles=[
 profile('default','Default','general',[],all_ids,local_only=True,desc='Local-only baseline.'),
 profile('full-feature','Full-feature','general',[],[i for i in all_ids if i != 'answer-reliability'],benchmark=True,desc='All Policies and Rules except advanced Answer Reliability; benchmark only.'),
 profile('sg-bank','Singapore Bank','banking',['sg'],[
  'payment-data','contact-data','identity-documents','credentials-secrets','sensitive-attributes','network-identifiers','pii-semantic',
  'content-safety-local','content-safety-model','risk-content-terms','prompt-instruction-attacks','application-injection','fraud-account-abuse',
  'financial-market-misconduct','business-topics','professional-advice','content-filters','regional-compliance-sg-pdpa'],local_only=True),
 profile('cn-financial-services','China Financial Services','banking',['cn'],[
  'payment-data','contact-data','identity-documents','credentials-secrets','sensitive-attributes','network-identifiers','pii-semantic',
  'content-safety-local','content-safety-model','risk-content-terms','prompt-instruction-attacks','application-injection','fraud-account-abuse',
  'financial-market-misconduct','business-topics','professional-advice','content-filters'],local_only=True),
 profile('cn-internet','China Internet','internet',['cn'],[
  'contact-data','payment-data','identity-documents','credentials-secrets','sensitive-attributes','network-identifiers','pii-semantic',
  'content-safety-local','content-safety-model','risk-content-terms','prompt-instruction-attacks','application-injection','fraud-account-abuse',
  'business-topics','professional-advice','content-filters'],local_only=True),
]

# Reviewed source-case contracts; never inferred from a failing test run.
composition=json.loads(Path('policies/profiles/composition.json').read_text())
for item in profiles:
 refs={p['policyId']:p for p in item['policies']}
 item['testExclusions']=[]
 for exclusion in composition['testExclusions']:
  ref=refs.get(exclusion['policyId'])
  if ref:
   assert ref['policyVersion']==exclusion['policyVersion'], 'Review stale Profile test exclusions'
   item['testExclusions'].append(exclusion)
 for override in composition['testCaseOverrides']:
  ref=refs.get(override['policyId'])
  if not ref or any(m['policyId'] not in refs or m['ruleId'] not in refs[m['policyId']]['enabledRuleIds'] for m in override['expectedMatches']): continue
  assert ref['policyVersion']==override['policyVersion'], 'Review stale Profile composition assertions'
  ref['testCaseOverrides'][override['sourceCaseId']]={
   'sourcePolicyVersion':override['policyVersion'],
   **{k:v for k,v in override.items() if k not in ['policyId','policyVersion','sourceCaseId']},
  }

text='import type { ProtectionPreset } from "./protection-map.js";\n\n// Generated by scripts/generate_profiles.py. Target Catalog only.\nexport const protectionPresets: readonly ProtectionPreset[] = '+json.dumps(profiles,ensure_ascii=False,indent=2)+' as const;\n'
target=Path('controller/shared/protection-presets.ts')
import sys
if '--check' in sys.argv:
 if target.read_text()!=text: raise SystemExit('Profiles are stale. Run scripts/generate_profiles.py.')
else:
 target.write_text(text)
 print('wrote',len(profiles))
