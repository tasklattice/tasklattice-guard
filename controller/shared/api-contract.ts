/** Business semantics supplement generated structural schemas. These names are independent of token scopes. */
export const apiTags = [
  ['account', 'Account', 'Authenticated identity and effective permissions.'],
  ['access-tokens', 'Account', 'Personal credential lifecycle; browser session required.'],
  ['guardrails', 'Guardrail Design', 'Guardrail drafts, immutable versions and release lifecycle.'],
  ['policies', 'Guardrail Design', 'Reusable Policies and their published versions.'],
  ['validation', 'Guardrail Design', 'Guardrail Test Cases and executable Guardrail/Policy validation runs.'],
  ['authoring', 'Guardrail Design', 'Intent analysis, document analysis and proposed plans.'],
  ['playground', 'Guardrail Design', 'Draft and published Guardrail interactions.'],
  ['routers', 'Integration', 'Router drafts, publication, simulation and Endpoint bindings.'],
  ['endpoints', 'Integration', 'Endpoint identities and runtime credentials.'],
  ['telemetry', 'Observability', 'Controller runtime observations and traffic statistics; not Runner invocation APIs.'],
  ['audit', 'Observability', 'Control-plane audit events.'],
  ['model-providers', 'Platform Settings', 'Provider connections, discovery and combined model registration.'],
  ['models', 'Platform Settings', 'Registered Model definitions, connection tests and capability tests.'],
  ['model-configurations', 'Platform Settings', 'Model assignments, validation evidence and activation.'],
  ['runners', 'Platform Settings', 'Runner capacity and instance lifecycle.'],
  ['system', 'Platform Settings', 'Public Controller readiness summary.'],
].map(([name, area, description]) => ({ name: name!, description: description!, 'x-product-area': area! }));

export function operationContract(method: string, path: string) {
  const tag = path.includes('/access-tokens') ? 'access-tokens' : path.includes('/account/') ? 'account'
    : path.includes('/authoring/') ? 'authoring' : path.includes('/playground/') ? 'playground'
    : path.includes('/model-configuration') ? 'model-configurations' : path.includes('/model-provider') ? 'model-providers'
    : path.includes('/models') ? 'models' : path.includes('/test-cases') || path.includes('/validation-runs') ? 'validation'
    : path.includes('/telemetry/') || path.endsWith('/traffic-distribution') ? 'telemetry'
    : path.includes('/routers') || path.includes('/routing/') ? 'routers' : path.includes('/endpoints') ? 'endpoints'
    : path.includes('/policies') || path.includes('/policy-catalog') ? 'policies'
    : path.includes('/guardrails') ? 'guardrails' : path.includes('/runner-') ? 'runners' : path.includes('/audit-events') ? 'audit' : 'system';
  const terminal = path.split('/').at(-1)!;
  const noun = (terminal.startsWith(':') ? path.split('/').at(-2)! : terminal).replaceAll('-', ' ');
  let summary = `${({ GET: 'Read', POST: 'Create', PUT: 'Replace', PATCH: 'Update', DELETE: 'Delete' } as Record<string, string>)[method]} ${noun}`;
  let description = method === 'GET' ? 'Reads current state without creating resources or advancing a lifecycle.'
    : method === 'DELETE' ? 'Removes only the resource identified by this path. An already absent resource may return 404.'
    : method === 'PUT' ? 'Replaces the addressed configuration. Review current state before overwriting concurrent changes.'
    : method === 'PATCH' ? 'Updates the supplied fields; omitted fields are retained. Validation or draft state may be invalidated.'
    : 'Creates a resource or executes the named operation. A network failure does not prove that execution failed.';
  let mode = method === 'GET' ? 'safe-read' : method === 'DELETE' || method === 'PUT' ? 'idempotent-effect' : 'not-guaranteed';
  let retry = method === 'GET' || method === 'DELETE' ? 'Repeat the same request; the response may reflect newer state or absence.' : 'Do not automatically retry an uncertain write. Read its result or current resource first.';
  let details: Record<string, unknown> = {};
  if (path.endsWith('/connection-tests')) { summary = 'Test connection and basic model invocation'; description += ' Stores connection evidence; it does not certify Guardrail capability or protocol correctness. Repeating can make another upstream call.'; }
  if (path.endsWith('/capability-tests')) { summary = 'Test model capability and protocol'; description += ' Stores capability evidence, separately from basic connection health. Repeating performs another probe.'; }
  if (path.includes('/model-provider-discoveries') || path.endsWith('/model-discoveries')) { summary = 'Discover available provider models'; description += ' Queries the provider catalog without registering resources. Draft discovery receives credentials in the body; existing-provider discovery uses stored credentials.'; }
  if (path.endsWith('/model-provider-registrations')) { summary = 'Register a provider and selected models'; description += ' Probes connections, then stores the provider and selected definitions in one database transaction. Capability validation remains a separate step.'; }
  if (path.endsWith('/draft/checks')) { summary = 'Read Policy draft checks and validation status'; description += ' Checks metadata and reads existing execution evidence; does not enqueue a Runner validation.'; }
  if (path.endsWith('/publication-preview')) { summary = 'Preview the exact Router publication'; description += ' Resolves latest Guardrail versions and bound Endpoints for the expectedDraftRevision without publishing. Send snapshot and endpointIds back as reviewedSnapshot and reviewedEndpointIds when publishing.'; mode = 'read-only-computation'; retry = 'May repeat; referenced versions or Endpoint bindings may have changed. Review the new result.'; }
  if (path === '/api/v1/playground/path-tests') { summary = 'Test Router routing or execute a Runner Endpoint request'; description += ' Published Router probes run on the configured Runner with a revision fence. Drafts only simulate selectors. Endpoint requests use the fixed Runner origin and supplied Endpoint credentials, not external Ingress. No arbitrary URL forwarding.'; retry = 'Simulation may repeat. Execution can incur model work; inspect the result before retrying.'; }
  if (path.endsWith('/simulations')) { summary = 'Simulate request matching against a Router draft'; description += ' Evaluates supplied draft and input without publishing or executing a Guardrail.'; mode = 'read-only-computation'; retry = 'May repeat with the same input.'; }
  if (path.endsWith('/traffic-distribution')) { summary = 'Read historical traffic distribution'; description += ' Reports request counts, decisions and trends. It is not configuration rollout status; inspect GET /routers/{id} rolloutStatus and desiredGeneration for rollout.'; }
  if (method === 'PUT' && path.endsWith('/endpoints')) { summary = 'Replace the Router Endpoint binding set'; description += ' An identical normalized set is a no-op: no new generation or redistribution. A changed set takes effect through desired-state distribution.'; }
  if (method === 'PUT' && path === '/api/v1/routers/:id/draft') { mode = 'conditional-replacement'; description += ' expectedDraftRevision is a concurrency precondition. Repeating a successful save with the old revision returns 409; this does not mean the first save failed.'; retry = 'GET the draft and compare contents after uncertainty; never substitute a newer expectedDraftRevision without review.'; }
  if (path.includes('/candidate-validations')) { summary = method === 'GET' ? 'Read candidate model validation evidence' : 'Validate a candidate model before assigning it'; description += ' Evidence is persisted across Controller instances, belongs to the authenticated account and target/model, and is valid for 10 minutes. POST returns validationId and expiresAt. It does not save the assignment. Pass validationId to the assignment PUT. Changed provider/model settings invalidate evidence.'; }
  if (method === 'PUT' && path.includes('/assignments/:target')) { description += ' Assigning a different non-null model requires a successful unexpired validationId for this account, target and unchanged model. Identical assignments are no-ops. Clearing uses modelId:null.'; }
  if (method === 'PUT' && path === '/api/v1/model-configuration/draft') { description += ' Replaces all assignments and clears validation only when assignments change. It does not certify the replacement; run draft validations before activation.'; }
  if (path.endsWith('/validations') && !path.includes('candidate-validations')) { summary = 'Validate saved model assignments'; description += ' Validates the currently saved target or whole draft; candidate model IDs are not accepted by this operation.'; }
  if (method === 'POST' && path.endsWith('/validation-runs')) { summary = 'Start an executable validation run'; description += ' Creates a new Runner task on each request. Track the returned run ID rather than latest, which can change when another task is created.'; }
  if (method === 'POST' && path.includes('/routers/') && /\/(publish|rollback)$/.test(path)) {
    summary = path.endsWith('/rollback') ? 'Publish a previous Router revision' : 'Publish the reviewed Router draft';
    mode = 'keyed'; description += ' expectedDraftRevision prevents stale publication. reviewedSnapshot and reviewedEndpointIds must be supplied together. The resource fields are current; publication.revision and publication.generation identify the original operation even on replay. GET publication.revisionUrl reads the immutable revision; GET publication.statusUrl reports current rolloutStatus and desiredGeneration. A later publication may supersede this revision.';
    retry = 'Repeat the same key and normalized body after uncertainty. Inspect publication.replayed and the original revision; do not issue a new key blindly.';
    details = { key: 'body.idempotencyKey', scope: 'routerId; publish and rollback share a namespace', retention: 'No time expiry. Deleted revisions retain a tombstone in audit history and reject replay.', requestComparison: 'SHA-256 of actorId, expectedDraftRevision, rollback revision, reviewed snapshot and normalized Endpoint set.', conflictStatus: 409, concurrentDuplicates: 'Serialized under the Router transaction lock.', replay: 'Original publication identity plus current Router; no new publication or distribution.' };
  }
  if (path.endsWith('/duplicate')) { mode = 'keyed'; summary = 'Copy a Guardrail source into a new Guardrail'; description += ' Choose sourceVersion or sourceDraftRevision. An absent source defaults to the active version. Replays return the current copied resource.'; details = { key: 'body.idempotencyKey', scope: 'actorId across Guardrail copy requests', retention: 'No time expiry; bound to the copied resource, including its soft-deletion record.', requestComparison: 'Source Guardrail ID, name and requested source version/draft revision.', conflictStatus: 409, concurrentDuplicates: 'Serialized by actor/key.', replay: 'Current copied resource; deleted copy returns not found without recreating it.' }; retry = 'Repeat the original key and body; do not create a new key merely because the response was lost.'; }
  if (path === '/api/v1/policies/:id/publish') { mode = 'revision-keyed'; summary = 'Publish a validated Policy draft'; description += ' expectedDraftRevision is required. The same Policy and source draft revision reuse the existing immutable published version.'; retry = 'Repeat the same expectedDraftRevision; a different revision is a different publication.'; }
  if (path === '/api/v1/guardrails/:id/publish') { summary = 'Compile and publish a validated Guardrail draft'; description += ' expectedDraftRevision is required. Existing results may be reused for the latest passed validation, but this is not a general request-key replay protocol. Track the returned version on GET /guardrails/{id}; ready/failed are compilation outcomes.'; }
  if (path === '/api/v1/guardrails/:id/rollback') { summary = 'Reactivate an explicit immutable Guardrail version'; description += ' version must identify a ready compiled version. Updates the active pointer and requests desired-state distribution; 200 confirms the control-plane change, not Runner readiness. Repeating can advance generation again. Read GET /guardrails/{id} before retrying.'; }
  if (path.endsWith('/validation-runs/latest')) { summary = 'Read the most recent Policy validation run'; description += ' The target can change when another run starts. To track your request, use the returned runId on /policies/{id}/validation-runs/{runId}.'; }
  if (path === '/api/v1/model-configuration/rollback') { summary = 'Roll back to an explicit model configuration revision'; description += ' targetRevisionId must identify a superseded revision. Control-plane Chat assignment is retained. This operation creates and activates a new revision; do not automatically retry it.'; }
  if (path.endsWith('/activate')) { summary = 'Activate the identified validated model configuration revision'; description += ' A revision can be consumed once; repeated activation can return 409. 200 means current distribution completed, 202 means it is still syncing. Read GET /model-configuration to track activating/active/failed by revision ID.'; }
  if (path.endsWith('/account/identity')) { summary = 'Read the current identity and effective permissions'; }
  if (path.includes('/access-tokens')) { description += ' Browser session only. Revocation is a no-op when already revoked. Creation returns the secret once; it cannot be recovered or transparently replayed.'; }
  return { tags: [tag], summary, description, 'x-product-area': apiTags.find(item => item.name === tag)!['x-product-area'], 'x-idempotency': { mode, ...details }, 'x-retry-policy': retry };
}
