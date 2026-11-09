from scripts.evaluate_f5_public import score_status


def test_unknown_conservative_block_is_not_success():
    assert score_status({'decision': 'block', 'usage': {'fail_closed': False},
                         'trace': [{'kind': 'action', 'verdict': 'unknown'}]}) == 'indeterminate'


def test_provider_failure_is_not_a_successful_block():
    assert score_status({'decision': 'block', 'usage': {'fail_closed': True}, 'trace': []}) == 'execution_error'
    assert score_status(None) == 'execution_error'


def test_matched_and_safe_decisions_are_scoreable():
    for verdict in ('matched', 'not_matched'):
        assert score_status({'usage': {'fail_closed': False},
                             'trace': [{'kind': 'action', 'verdict': verdict}]}) == 'complete'
