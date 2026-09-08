"""Deterministic Topic Control endpoint for isolated engineering tests only.

No credentials, HTTP client or real-model fallback. Explicit cases, not a judge.
"""
import argparse
import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

MODEL = "mock/nemoguard-topic-control"
DEFAULT_CASES = Path(__file__).resolve().parents[1] / 'tests/fixtures/model_responses/topic-control-synthetic.json'


def create_app(cases_path=DEFAULT_CASES, *, scenario='normal', delay_seconds=10):
    if scenario not in {'normal', 'http-error', 'invalid-response', 'timeout'}:
        raise ValueError('Unknown scenario')
    cases = json.loads(Path(cases_path).read_text())['cases']
    if any(case['result'] not in {'on-topic', 'off-topic'} for case in cases):
        raise ValueError('Invalid Topic Control fixture result')
    stats = {'requests': 0, 'matched': 0, 'unmatched': 0}
    app = FastAPI()

    @app.get('/health')
    def health():
        return {'mode': 'synthetic-mock', 'scenario': scenario, 'external_calls': 0, **stats}

    @app.get('/v1/models')
    def models():
        return {'object':'list', 'data':[{'id':MODEL, 'object':'model', 'owned_by':'synthetic-test-only'}]}

    @app.post('/v1/chat/completions')
    async def completion(request: Request):
        stats['requests'] += 1
        raw = await request.body()
        if len(raw) > 100_000:
            return JSONResponse({'error':'Request too large'}, status_code=413)
        try:
            body = json.loads(raw)
        except ValueError:
            return JSONResponse({'error':'Invalid JSON'}, status_code=400)
        if not isinstance(body, dict) or body.get('model') != MODEL or body.get('stream'):
            return JSONResponse({'error':'Use the Mock model and a non-stream classification request'}, status_code=400)
        messages = body.get('messages')
        if (not isinstance(messages, list) or not messages or len(messages) > 2
                or any(not isinstance(m, dict) or not isinstance(m.get('content'), str) for m in messages)
                or messages[-1].get('role') != 'user'
                or len(messages) == 2 and messages[0].get('role') != 'system'):
            return JSONResponse({'error':'Unsupported message shape; provide an explicit fixture'}, status_code=400)
        system = messages[0]['content'] if len(messages) == 2 else ''
        user = messages[-1]['content']
        matches = [case for case in cases if case['user'] == user and (
            all(part in system for part in case['system_contains']) if case['system_contains'] else not system)]
        if len(matches) != 1:
            stats['unmatched'] += 1
            return JSONResponse({'error':'No unambiguous synthetic fixture; no real-model fallback'}, status_code=409)
        stats['matched'] += 1
        if scenario == 'http-error':
            return JSONResponse({'error':'Synthetic Topic Control outage'}, status_code=500)
        if scenario == 'timeout':
            await asyncio.sleep(delay_seconds)
        content = 'invalid-topic-verdict' if scenario == 'invalid-response' else matches[0]['result']
        return {'id':'chatcmpl-synthetic-topic', 'object':'chat.completion', 'created':0, 'model':MODEL,
            'choices':[{'index':0,'message':{'role':'assistant','content':content},'finish_reason':'stop'}],
            'usage':{'prompt_tokens':0,'completion_tokens':0,'total_tokens':0},
            'mock': True, 'fixture_id':matches[0]['id']}

    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1', help='Bind address; use 0.0.0.0 only inside an isolated test container')
    parser.add_argument('--port', type=int, default=8098)
    parser.add_argument('--cases', type=Path, default=DEFAULT_CASES)
    parser.add_argument('--scenario', choices=['normal','http-error','invalid-response','timeout'], default='normal')
    args = parser.parse_args()
    uvicorn.run(create_app(args.cases, scenario=args.scenario), host=args.host, port=args.port, access_log=False)
