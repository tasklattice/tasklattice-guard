"""Opt-in context formats: independent fixtures, syntax preservation and boundaries."""
import pytest
from runner.toolkit.policy_library import policy
from runner.toolkit.nemo.actions.content_filter import BuiltinContentFilter
from runner.toolkit.policy_runtime.detectors import validate_regex_options

RULES = ('pattern/titled_person', 'pattern/contact_list_person', 'pattern/truncated_address')

def run(text, phase='input', rules=RULES):
    p = policy('local-contact-data')
    return BuiltinContentFilter().evaluate(definitions={p.id:p}, policies=(p.id,), text=text,
                                         phase=phase, enabled_rules={p.id:rules}).content

@pytest.mark.parametrize('phase', ['input', 'output'])
@pytest.mark.parametrize('source,expected', [
    ('Contact Dr. Alex Example, please.', 'Contact [titled_person_REDACTED], please.'),
    ('<em>A<strong>Lady</strong> <strong>Elena Example</strong></em>', '<em>A<strong>[titled_person_REDACTED]</strong> <strong>[titled_person_REDACTED]</strong></em>'),
    ('<p>Madame <b>Élise-Marie</b> Example', '<p>[titled_person_REDACTED]<b>[titled_person_REDACTED]</b>[titled_person_REDACTED]'),
    ('<p>Dr. &Eacute;lise Example</p>', '<p>[titled_person_REDACTED]</p>'),
    ('Dr. Alex Example and Dr. Jordan Sample.', '[titled_person_REDACTED] and [titled_person_REDACTED].'),
    ('contact:\n  - +321 45-678 9012\n  - Alex\n  - Sample\n  - 123-45-6789', 'contact:\n  - +321 45-678 9012\n  - [contact_list_person_REDACTED]\n  - [contact_list_person_REDACTED]\n  - 123-45-6789'),
    ('  * 123456789\n  * "Alex-Marie"\n  * +321 45-678 9012', '  * 123456789\n  * "[contact_list_person_REDACTED]"\n  * +321 45-678 9012'),
    ('- [us_ssn_REDACTED]\n- Alex\n- +321 45-678 9012', '- [us_ssn_REDACTED]\n- [contact_list_person_REDACTED]\n- +321 45-678 9012'),
    ('eet": "Example Road", "city":"Exampleville", "postcode":"90210"}', 'eet": "[truncated_address_REDACTED]", "city":"Exampleville", "postcode":"90210"}'),
    ('ss_line1": "North Example Lane", "postcode":"90210", "city":"Exampleville"}', 'ss_line1": "[truncated_address_REDACTED]", "postcode":"90210", "city":"Exampleville"}'),
])
def test_source_preserving_context_formats(source, expected, phase):
    assert run(source, phase) == expected

@pytest.mark.parametrize('text', [
    'Read the chapter about the Countess.', 'Dr. Please explain this topic.',
    '<h1>Professor</h1><p>Alex Example</p>', '<script>"Dr. Alex Example"</script>',
    '<code>Dr. Alex Example</code>', '<head><title>Dr. Alex Example</title></head>',
    '<p data-name="Dr. Alex Example">Hello</p>', 'A<strong>Person</strong> <strong>Alex Example</strong>',
    'reading:\n  - Physics\n  - Chemistry', 'reading:\n  - +321 45-678 9012\n  - Physics',
    'reading:\n  - 123456789\n  - Physics',
    '- [anything_REDACTED]\n- Physics\n- +321 45-678 9012',
    'first:\n  - +321 45-678 9012\nsecond:\n  - 123456789\n  - Physics',
    '- +321 45-678 9012\n  - 123456789\n  - Physics',
    '- +321 45-678 9012\n- 123456789\n\n- Physics',
    'title": "Example Road", "city":"Exampleville"}',
    'Read "Example Road", then use city and postcode fields.',
    'eet": "Example Road"}, {"city":"Exampleville", "postcode":"90210"}',
    'Return by 04/06/2023 at 5:47am.',
])
def test_no_cross_record_or_context_free_name_inference(text):
    assert run(text) == text

def test_list_context_is_bounded_and_does_not_reorder_source():
    source='- +321 45-678 9012\n- 123456789\n' + '- Alex\n'*31
    assert run(source) == source
    source='- +321 45-678 9012\n- 123456789\n- '+('x'*8192)+'\n- Alex'
    assert run(source) == source

@pytest.mark.parametrize('options', [
    {'capture_group':'v','text_view':'unknown'},
    {'capture_group':'v','sibling_patterns':['x']},
    {'capture_group':'v','sibling_patterns':['x',1]},
    {'capture_group':'v','sibling_patterns':['x','y'],'text_view':'html_text'},
])
def test_context_options_are_validated(options):
    with pytest.raises(ValueError):validate_regex_options('(?P<v>x)',options)

def test_identifier_first_transform_keeps_name_context_and_full_identifier_redaction():
    government, contact = policy('local-government-identifiers'), policy('local-contact-data')
    result = BuiltinContentFilter().evaluate(
        text='- 123-45-6789\n- Alex\n- +321 45-678 9012',phase='input',
        policies=(government.id,contact.id),definitions={government.id:government,contact.id:contact},
        enabled_rules={government.id:['pattern/us_ssn'],contact.id:['pattern/contact_list_person','pattern/international_phone']},
        rule_order={contact.id:['pattern/contact_list_person','pattern/international_phone']})
    assert result.content == '- [us_ssn_REDACTED]\n- [contact_list_person_REDACTED]\n- [international_phone_REDACTED]'
