# Model Configuration

The Default Guardrail runs locally without a detection-model setup. Configure
models when your selected Policies require model-backed checks. Provider
connectivity, model callability, and assignment to a protection check are
separate steps.

## Providers, Models, and Guardrail Catalog

The Helm install command does not read model configuration or credentials from
`.env` and does not create Provider Secrets. Runtime model configuration has four
separate UI owners:

| Settings page | Responsibility |
| --- | --- |
| Health | Global Controller, baseline Guardrail, Runner convergence, and active model-binding readiness |
| Providers | Endpoint, encrypted credential, discovery, connectivity, and Provider-scoped TLS policy |
| Models | Registered inventory plus one real callability check per physical model |
| Guardrail Catalog | Rail-specific model assignment, behavioral validation, Save, and activation |

A callable model is not automatically used by a Rail. The active Guardrail
Catalog revision maps a stable binding such as `content_safety.input`,
`content_safety.output`, or `jailbreak.input` to one registered model. One model
may serve multiple bindings when its explicit protocol profile supports each
contract. Input and Output assignments remain independent.

DeepSeek Providers are control-plane-only. Controller rejects DeepSeek as a
Data Plane assignment and projects only models referenced by active Data Plane
bindings—and only their credentials—to Runner. Data Plane Rails must use a
purpose-built or bounded low-parameter model. This boundary is enforced by the
API and desired-state protocol, not only by filtering a browser dropdown.

The current executable Rail surface is Input and Output. Retrieval, Dialog, and
Execution are reserved manifest values for later expansion; adding them extends
the shared binding manifest without changing Provider, Model, Policy, or
Guardrail ownership.

## Dedicated JailbreakDetect or a chat-based judge

`nvidia/nemoguard-jailbreak-detect` is an additional implementation of the existing
`tali.guard.jailbreak.v1` capability, alongside an OpenAI-compatible chat judge and
Qwen3Guard. It does not add a new scenario, modify Policies, or recompile Guardrail
artifacts when the selected detector changes.

- **NVIDIA hosted:** use the existing NVIDIA NIM Provider
  (`https://integrate.api.nvidia.com/v1`). Discovery includes JailbreakDetect as a
  supported endpoint candidate even when it is absent from the chat catalog.
  Registration makes an actual call; a catalog entry does not prove availability.
  Only this exact public NVIDIA origin is mapped to the official security API.
- **Self-hosted NIM:** register a Provider using its full
  `https://your-nim-host/v1/classify` URL. Discovery checks that classifier directly;
  a Chat Completions or `/models` endpoint is not required. Custom gateway prefixes
  remain intact and never redirect to NVIDIA's public service.
- Register the model in **Models**, then select it for **Jailbreak detection** in
  **Guardrail Catalog → Input**, validate, save, and activate. The protocol is inferred for the
  canonical model ID; deployment aliases can use the existing protocol settings.
  Any chat model that supports OpenAI-compatible Chat Completions can instead use
  the `tali.openai-compatible-jailbreak.v1` profile and must return `SAFE` or
  `JAILBREAK` for the supplied classification prompt.

The dedicated client sends raw user input as `{"input":"..."}` and strictly
checks the native `jailbreak` boolean and finite `[-1, 1]` `score`. It uses the
service's boolean decision, not an invented local threshold. It does not send
chat prompts, model IDs, or generation parameters. **Models → Test call** checks
the response envelope only; **Guardrail Catalog → Validate** runs both benign and
jailbreak smoke samples. These samples do not constitute a comprehensive accuracy
benchmark. Classification errors remain errors and follow the Guardrail's failure
policy; they never become a safe verdict. This detector is input-only.

Tests are separated by architectural ownership: Controller tests cover registration,
endpoint routing, validation, and assignment; Runner tests load the frozen signed
`jailbreak-v1` artifact and exercise both detectors through the real runtime API
without importing the compiler or contacting external model services. Both sides
also test Provider-scoped self-signed TLS behavior.

Protocol references: [NVIDIA hosted classification API](https://docs.api.nvidia.com/nim/reference/nvidia-nemoguard-jailbreak-detect-infer)
and [self-hosted NIM request/response examples](https://docs.nvidia.com/nim/nemoguard-jailbreakdetect/latest/getting-started.html).

## Provider TLS settings

For a trusted Provider using a private CA or self-signed HTTPS certificate,
enable **Skip TLS certificate verification** under **Settings → Providers**.
The switch appears below the HTTPS Base URL during registration; saved Providers
have a **TLS settings** action. It defaults to off and applies only to that
Provider's discovery, detector validation, and Control Plane/Data Plane model
requests. Enabling it skips certificate-chain and hostname checks, not HTTPS
encryption. Changes are persisted and sent to active Runners; test affected models
again in Models and revalidate their bindings in Guardrail Catalog because previous
connection and validation evidence is cleared.
This does not change Controller–Runner mTLS or other Providers' verification.

For model revision activation and rollback, see
[revision lifecycles](revision-lifecycle.md). API clients should follow
[model-binding validation conventions](api-contract.md#validation-credentials-for-model-bindings).
