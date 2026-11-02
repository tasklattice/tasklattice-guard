"""Structured PII redaction preserves syntax and covers the entire value."""
import pytest
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.policy_library import policy
from runner.toolkit.policy_runtime.detectors import LocalDetector, DetectorInput, validate_regex_options
from runner.toolkit.policy_runtime.codec import policy_from_payload

NEW=('pattern/structured_username','pattern/structured_address','pattern/labelled_person','pattern/international_phone')
def run(text,phase='input'):
 p=policy('local-contact-data')
 return BuiltinContentFilter().evaluate(definitions={p.id:p},policies=(p.id,),text=text,phase=phase,enabled_rules={p.id:NEW})

@pytest.mark.parametrize('phase',['input','output'])
@pytest.mark.parametrize('text,expected',[
 ('<Username>B</Username> Body','<Username>[structured_username_REDACTED]</Username> Body'),
 ('{"user_name" : "alex.sample17", "status": "active"}','{"user_name" : "[structured_username_REDACTED]", "status": "active"}'),
 ('<Username>first.user</Username><Username>second.user</Username>','<Username>[structured_username_REDACTED]</Username><Username>[structured_username_REDACTED]</Username>'),
 ('{"city":"Exampleville","state": "CA", "postcode":"90210","medical_information":{}}','{"city":"[structured_address_REDACTED]","state": "[structured_address_REDACTED]", "postcode":"[structured_address_REDACTED]","medical_information":{}}'),
 ('- Teacher: Alex Example\n- Strengths: Creative','- Teacher: [labelled_person_REDACTED]\n- Strengths: Creative'),
 ('{"country":"Example Republic","building":"123","street":"Example Road"}','{"country":"[structured_address_REDACTED]","building":"[structured_address_REDACTED]","street":"[structured_address_REDACTED]"}'),
 ('Phone +345 67-123 4567','Phone [international_phone_REDACTED]'),
 ('Phone +192-478-234.5678','Phone [international_phone_REDACTED]'),
])
def test_complete_field_redaction(text,expected,phase):
 assert run(text,phase).content==expected

@pytest.mark.parametrize('text',[
 'Return feedback by [04/06/2023].','Read the Username documentation.',
 'A clinical teacher: explains the procedure.', 'The city has beautiful streets.',
 'commit ab23456789cd', 'version +1.2.3', 'value +123 456 789 012 3456',
 'url https://example.org/docs', 'The capital of CA is Sacramento.', '{"state":"ready"}', '{"country":"United States"}',
 'Teacher: Please explain the chapter in detail', '{"building":true,"state":"ready"}',
])
def test_no_generic_dates_names_or_prose_masking(text):
 assert run(text).content==text


def test_capture_options_validate_and_optional_groups_never_produce_negative_spans():
 for options in [{'capture_group':'missing'},{'capture_group':1},{'capture_group':'v','extra':True}]:
  with pytest.raises(ValueError):validate_regex_options('(?P<v>x)',options)
 d=LocalDetector();cfg=DetectorInput(expression=r'field:(?P<v>x)?',options={'capture_group':'v'})
 assert d.detect('regex',cfg,'field:','input',{}) is None
 assert d.detect('regex',cfg,'field:x','input',{}).spans==((6,7),)
 # Unopted regexes keep their complete historical span, regardless of group name.
 assert d.detect('regex',DetectorInput(expression='field:(?P<v>x)'), 'field:x','input',{}).spans==((0,7),)
