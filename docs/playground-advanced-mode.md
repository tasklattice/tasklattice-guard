# Playground Advanced Path Testing

The top of Playground offers “Normal mode / Advanced mode,” with Normal mode selected by default. Normal mode continues to provide GuardRail chat testing, with the model, GuardRail, Version, and send button below the input. Advanced mode uses an API request workbench layout.

## Usage

1. Switch to Advanced mode at the top of the page, or enter through the test action on a Router / Endpoint detail page.
2. Select the test target at the top. For a Router, also select Revision, source Endpoint, and test scope; an Endpoint automatically shows its bound Router.
3. Method, URL, and send button share one request bar. Router requests describe the business request; Endpoint requests automatically fill in a fixed POST invocation path.
4. Edit Headers in a key/value table with add, remove, enable, and disable controls. Body supports text / JSON, formatting, and JSON syntax feedback. Other Router matching fields appear under “Routing context,” and the Endpoint API Key appears under “Authentication.”
5. “Import HTTP/cURL” opens a sheet. Successful parsing replaces the same request data; failed parsing preserves the original request.
6. The area below shows only the current test result: GuardRail, Version, Runner, duration, and routing analysis / detection results / raw response. A rule-analysis table explains matches, skips, and reasons.
7. The divider between request and result is draggable and also supports arrow keys and Home / End. Each panel scrolls independently to avoid deeply nested scroll areas in JSON details.
8. The history sheet keeps the 50 most recent tests in the current page session. Restoring an entry restores the request and corresponding result without sending it automatically or restoring credentials.

Switching between Normal and Advanced modes preserves each mode's inputs and history. Refreshing clears Advanced test history. Edited requests are retained separately for each Endpoint so selecting a new target does not send a previous protocol's Body to another path.

## Actual Invocation Paths

| Mode | Path | Verification scope |
| --- | --- | --- |
| Normal GuardRail chat | Existing Playground service → Runner | Chat protection using a specified GuardRail Version / Draft preview |
| Published Router, routing only | Controller → Runner internal test endpoint → Loaded Selector and weighted allocator | Matching and target allocation for the actual Router Revision, without GuardRail execution |
| Published Router, execute | Controller → Runner internal test endpoint → Runtime → GuardRail | Detection using the HTTP Body as input text; uses the bound Endpoint's routing context without validating its ingress authentication |
| Router draft | Controller draft matcher | Rule matching and candidate targets; no actual weighted allocation or GuardRail execution |
| Endpoint | Controller → Runner Endpoint API → Router → GuardRail | Endpoint API Key, protocol parsing, routing, and GuardRail execution |

Published Router requests carry an expected Revision. The Controller checks the current published revision and Endpoint bindings; the Runner then checks the loaded revision. Unsynchronized or changed revisions return an error. Execution also checks the version actually resolved by Runtime. The same Call ID follows Runtime's routing-pinning rules; generate a new Call ID in request context to test again.

Endpoint mode follows protocol fields and Call ID in the request Body. Host in the HTTP editor supplies request context; the network destination is fixed to the Runner service configured in the Controller. Currently supported paths are the selected Endpoint's POST `guardrails/evaluate` and `beta/litellm_basic_guardrail_api`. External Ingress, DNS, TLS, and a complete third-party model round trip are outside this path test's scope.

Endpoint tests use the entered API Key (also accepting X-Api-Key from HTTP), never forwarding the Controller's internal token. Sensitive request headers are masked in history; the request Body retains user input. cURL is parsed only as text: it does not execute a shell or read files.

## Component Responsibilities

- `PlaygroundPage`: top-level mode Tabs and two persistently mounted workspaces.
- `AdvancedPlayground`: assembles the request workbench regions.
- `usePathWorkbench`: target selection, request document, sending state, current result, and session history.
- `path-request-model`: import, serialization, and Endpoint templates for GUI documents and HTTP text.
- `PathTargetBar`: target configuration and Method / URL / send bar.
- `PathRequestEditor`: Headers, Body, context / authentication, and import sheet.
- `PathWorkbenchSplit`: draggable, keyboard-accessible split panels.
- `PathTestResult`: result summary, rule table, detection information, and raw response.
- `PathTestHistory`: history browsing and restoration.

This directly replaces the old Advanced mode without a legacy-interaction compatibility branch. It reuses existing Tabs, Input, Select, and Sheet components without adding a large API client or editor dependency.

## Verification Record (2026-09-13)

- Controller / UI regression: 44 tests passed across 11 files, covering GUI serialization, disabled and duplicate Headers, import validation, Endpoint document isolation, authentication errors, credential exclusion, history restoration, real-service transport boundaries, and Revision validation.
- `npm run build` passed, including UI, server type checks, and OpenAPI consistency checks. The project's existing large-bundle warning remains.
- Real browser tests: Router routing and execution succeeded; Endpoint without credentials returned 401, then executed successfully with isolated test credentials; the Normal chat draft survived mode switches.
- Desktop 1440×1000 and mobile 390×844 were checked. Mobile selectors use two columns, the send button occupies a full row, and the page has no horizontal overflow; the split is keyboard-adjustable.
- Execution was verified using an isolated local Runner, a repository-signed test Artifact, and real NeMo Runtime. No existing cluster was deployed to or modified.
- Runner logic did not change with this layout update; prior Runner regression for this implementation had 66 passes and 1 skip.

The UI review used Product Console / release_gate. Target and send actions, request/result hierarchy, actual execution evidence, error recovery, keyboard operation, and brand-component consistency all passed. Long fields on mobile still require moving the cursor within an input to see the full value, so compact-screen readability under System Craft was a partial pass. The six dimension scores were 10, 10, 8.75, 10, 10, and 10 (four subchecks per dimension, two points each, with one System Craft subcheck scoring one point). Weighted at 22%, 22%, 14%, 18%, 16%, and 8%, the total was 9.83. Release still requires the environment synchronization conditions below.

Deployment must include both the Controller and Runner path-testing updates and confirm the Router Revision has synchronized to Runners. Updating only UI or Controller leaves old Runners without the new internal Router test endpoint.
