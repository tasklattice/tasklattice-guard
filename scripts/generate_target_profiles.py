from pathlib import Path
import json
policies={p['id']:p for p in json.loads(Path('runner/toolkit/policy_library/assets_target/target_policies.json').read_text())}

# Non-benchmark Profiles start from a disjoint local subset. Full-feature keeps
# every Rule for exhaustive benchmarking; the product baseline must not rely on
# generic Rules shadowing specific Rules or block/transform Policy conflicts.
NON_BENCHMARK_EXCLUDED_POLICIES = {"risk-content-terms", "sensitive-attributes"}
NON_BENCHMARK_RULES = {
    "payment-data": {
        "financial-pii/credit_card", "financial-pii/iban", "pattern/ca_bank_account",
        "pattern/sg_bank_account", "cn-personal-information/unionpay-card",
    },
    "identity-documents": {
        "identity/passport", "au-pii-tax-identifiers/au_tfn", "au-pii-tax-identifiers/au_abn",
        "au-pii-tax-identifiers/au_medicare", "pattern/uae_emirates_id", "pattern/ca_on_drivers_licence",
        "pattern/ca_immigration_doc", "pattern/fr_nir", "pattern/sg_uen", "pattern/ca_ohip",
        "pattern/ca_sin", "pattern/eu_vat", "pattern/nl_bsn_contextual", "pattern/us_ssn",
        "pattern/br_cpf", "pattern/br_cnpj", "pattern/br_rg", "pattern/sg_nric",
        "cn-business-identifier/unified-social-credit-code", "cn-personal-information/resident-identity-card",
    },
    "contact-data": {"pattern/email", "pattern/international_phone"},
    "content-filters": {"competitor/intent", "keyword/blocked-words"},
    "credentials-secrets": {
        "credentials-api-keys/generic_api_key", "credential/bearer-token",
        "credential/private-key-header", "credential/password",
    },
}

MODEL={'model/classifier','model/grounding','service/formal-verification'}
def policy_selection(ids, local_only=False, benchmark=False):
 out=[]
 for pid in ids:
  if not benchmark and pid in NON_BENCHMARK_EXCLUDED_POLICIES:
   continue
  p=policies[pid]
  rules=[r for r in p['rules'] if not local_only or r['detector']['ref'] not in MODEL]
  if not benchmark and pid in NON_BENCHMARK_RULES:
   allowed=NON_BENCHMARK_RULES[pid]
   rules=[r for r in rules if r['id'] in allowed]
  # Agent boundary Rules use dedicated NeMo actions and cannot execute in a
  # mixed ContentFilter action group yet; keep them out of the current Profile
  # baseline until the boundary Policy is split out.
  if not benchmark:
   rules=[r for r in rules if not r['detector']['ref'].startswith('agent/')]
  if not rules: continue
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
 return {'id':pid,'version':'1.0.0','name':name,'description':desc,'industry':industry,'jurisdictions':jurisdictions,
  'benchmarkOnly':benchmark,'policies':policy_selection(policies_ids,local_only,benchmark),'parameterPacks':[],
  'draftSettings':{'allowedTopics':[],'restrictedTopics':[],'topicControlMode':'strict','safetyLevel':'balanced','outputDelivery':'full_buffered'},
  'suggestedTopics':[],'optionalPolicyIds':[],'limitations':[]}
all_ids=list(policies)
local_exclude={'pii-semantic','content-safety-model','answer-reliability'}
local_ids=[i for i in all_ids if i not in local_exclude and not i.startswith('regional-compliance')]
profiles=[
 profile('default','Default','general',[],local_ids,local_only=True,desc='Local-only baseline.'),
 profile('full-feature','Full-feature','general',[],[i for i in all_ids if i != 'answer-reliability'],benchmark=True,desc='All target Policies and Rules except advanced Answer Reliability; benchmark only.'),
 profile('sg-bank','Singapore Bank','banking',['sg'],[
  'payment-data','contact-data','identity-documents','credentials-secrets','sensitive-attributes','network-identifiers','pii-semantic',
  'content-safety-local','content-safety-model','risk-content-terms','prompt-instruction-attacks','application-injection','fraud-account-abuse',
  'financial-market-misconduct','business-topics-advice','content-filters','regional-compliance-sg-pdpa'],local_only=True),
 profile('cn-financial-services','China Financial Services','banking',['cn'],[
  'payment-data','contact-data','identity-documents','credentials-secrets','sensitive-attributes','network-identifiers','pii-semantic',
  'content-safety-local','content-safety-model','risk-content-terms','prompt-instruction-attacks','application-injection','fraud-account-abuse',
  'financial-market-misconduct','business-topics-advice','content-filters'],local_only=True),
 profile('cn-internet','China Internet','internet',['cn'],[
  'contact-data','payment-data','identity-documents','credentials-secrets','sensitive-attributes','network-identifiers','pii-semantic',
  'content-safety-local','content-safety-model','risk-content-terms','prompt-instruction-attacks','application-injection','fraud-account-abuse',
  'business-topics-advice','content-filters'],local_only=True),
]


text='import type { ProtectionPreset } from "./protection-map.js";\n\n// Generated by scripts/generate_target_profiles.py. Target Catalog only.\nexport const targetProtectionPresets: readonly ProtectionPreset[] = '+json.dumps(profiles,ensure_ascii=False,indent=2)+' as const;\n'
Path('controller/shared/target-protection-presets.ts').write_text(text)
print('wrote',len(profiles))
