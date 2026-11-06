from pathlib import Path
from collections import defaultdict
import csv, json, shutil
import yaml
from runner.toolkit.policy_library.package import load_package
from runner.toolkit.policy_library.rules import RuleRegistry
from runner.toolkit.policy_library.declarative import PolicyDefinition, TestDefinition
from runner.toolkit.policy_library.package import PolicyManifest

ROOT=Path('policies'); TARGET=ROOT/'target'
rows=list(csv.DictReader(open('docs/policy-rule-mapping.csv')))
# Target ids from the approved catalog.
target_ids={
 'Payment Data':'payment-data','Contact Data':'contact-data','Identity Documents':'identity-documents',
 'Credentials & Secrets':'credentials-secrets','Sensitive Attributes':'sensitive-attributes','Network Identifiers':'network-identifiers',
 'PII (Semantic)':'pii-semantic','Content Safety (Local)':'content-safety-local','Content Safety (Model)':'content-safety-model',
 'Risk Content Terms':'risk-content-terms','Prompt & Instruction Attacks':'prompt-instruction-attacks',
 'Application Injection':'application-injection','Fraud & Account Abuse':'fraud-account-abuse',
 'Financial Market Misconduct':'financial-market-misconduct','Business Topics & Advice':'business-topics-advice',
 'Content Filters':'content-filters','Answer Reliability':'answer-reliability',
 'Regional Compliance: SG PDPA':'regional-compliance-sg-pdpa','Regional Compliance: EU AI Act':'regional-compliance-eu-ai-act',
 'Regional Compliance: UAE Content Standards':'regional-compliance-uae-content-standards',
}
by_target=defaultdict(list)
for row in rows:
    by_target[row['new_policy']].append(row)
assert set(by_target) == set(target_ids), (set(by_target)-set(target_ids), set(target_ids)-set(by_target))
# Load source packages and tests.
source={}
for p in (ROOT/'builtin').glob('*/policy.yaml'):
    pkg=load_package(p.parent)
    source[pkg.definition.metadata.id]=pkg
if TARGET.exists(): shutil.rmtree(TARGET)
TARGET.mkdir()
for target, entries in sorted(by_target.items()):
    pid=target_ids[target]
    pdir=TARGET/pid; (pdir/'tests').mkdir(parents=True)
    refs=[]; seen=set(); params={}; tests=[]; testing={}
    source_ids=set()
    for entry in entries:
        source_ids.add(entry['current_policy_id'])
        key=(entry['rule_id'], entry['rule_version'] if 'rule_version' in entry else '1.0.0')
        if key not in seen:
            refs.append({'id':entry['rule_id'],'version':'1.0.0'}); seen.add(key)
    for sid in sorted(source_ids):
        pkg=source[sid]
        for param in pkg.definition.parameters:
            params.setdefault(param.name,param.model_dump())
        testing.update(pkg.manifest.testing.parameters)
        for test in pkg.definition.tests:
            if test.kind != "rule_acceptance":
                continue
            item=test.model_dump(exclude_none=True)
            item['id']=f'{sid}/{item["id"]}'
            item['name']=f'{sid}: {item["name"]}'
            tests.append(item)
    # Keep only tests that can be evaluated by this target's Rules.
    rule_ids={r['id'] for r in refs}
    kept=[]
    for test in tests:
        if not set(test.get('covered_rule_ids',[])).issubset(rule_ids):
            continue
        if test.get('expected_matched_rules') and not set(test['expected_matched_rules']).issubset(rule_ids):
            continue
        kept.append(test)
    # Deduplicate Rule IDs after shared references.
    unique={}
    for test in kept: unique.setdefault(test['id'],test)
    tests=list(unique.values())
    topic=entries[0]['new_protection_topic']
    directory={
      'payment_data':'privacy','contact_data':'privacy','identity_documents':'privacy',
      'credentials_secrets':'privacy','sensitive_attributes':'privacy','network_identifiers':'privacy','privacy':'privacy',
      'content_safety':'content_safety','prompt_attacks':'attacks_and_abuse','application_injection':'application_injection',
      'fraud_account_abuse':'business_rules','financial_misconduct':'business_rules','business_topics':'business_topics',
      'content_filters':'content_filters','answer_reliability':'answer_reliability','regional_compliance':'privacy',
    }[topic]
    policy={
      'schema_version':1,'kind':'Policy',
      'metadata':{'id':pid,'name':target,'description':f'Target taxonomy Policy: {target}.',
        'source':'built_in','version':'1.0.0',
        'tags':[{'namespace':'protection','value':directory,'label':directory.replace('_',' ').title()},
                {'namespace':'collection','value':'target-policies','label':'Target Policies'}],
        'safety_level':'balanced','output_delivery':'full_buffered'},
      'parameters':list(params.values()),'rules':[],'rule_refs':refs,
      'tests':['tests/acceptance.yaml']}
    if testing:
        policy['testing']={'parameters':{k:v for k,v in testing.items() if k in params}}
    (pdir/'policy.yaml').write_text(yaml.safe_dump(policy, sort_keys=False, allow_unicode=True))
    (pdir/'tests/acceptance.yaml').write_text(yaml.safe_dump(tests, sort_keys=False, allow_unicode=True))
print('generated',len(by_target),'packages')
