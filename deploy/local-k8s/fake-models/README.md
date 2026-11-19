# Local fake models for TaskLattice Guard

These examples use the `mt-demo-v2` namespace on the `guard-tenants` kind cluster. Both mock services serve OpenAI-compatible Chat Completions at `POST /v1/chat/completions` and list their model IDs at `GET /v1/models`. Each runs the mock server in its own Deployment and accepts unauthenticated calls through a ClusterIP Service. The manifests use the Runner image already loaded on the demo nodes as a Python runtime. On a different cluster, set both image tags in `workloads.yaml` to a Runner image loaded on its nodes, such as the development build tagged `dev`.

| Service | Base URL for in-cluster callers | Model IDs |
| --- | --- | --- |
| Echo | `http://fake-llm-echo.mt-demo-v2.svc.cluster.local:8097/v1` | `fake-echo` |
| Guard classifiers | `http://fake-llm-guard.mt-demo-v2.svc.cluster.local:8097/v1` | `fake-guard-jailbreak`, `fake-guard-pii` |

Echo returns the text of the last user message, including whitespace, as the assistant reply. It supports regular JSON responses and streaming. Use it as the application model. Use the classifier service as a Guard detector dependency. The classifiers return verdicts, and the Rules in the Guardrail determine the final action.

## Configure the classifier mapping

Edit [mapping.json](mapping.json). The key is the full leading number in the text the detector receives, with optional leading whitespace. A number followed by `:`, whitespace, or the end of the text qualifies. `2: hello` and `2 hello` select `"2"`. `20: hello` selects `"20"`, and `2hello` uses the default.

| Example text | Mapping value | Jailbreak verdict | Semantic PII verdict | Expected Guard behavior with the Rules below |
| --- | --- | --- | --- | --- |
| `0: hello` | `allow` | `SAFE` | `safe` | Allow and echo the text |
| `1: hello` | `block` | `JAILBREAK` | `safe` | Block on the Jailbreak input Rule |
| `2: hello` | `transform` | `SAFE` | `pii` | Replace the inspected block with `[PII_REDACTED]` |
| `3: hello` | `unknown` | `SAFE` | `unknown` | Exercise the Semantic PII Rule's unknown-verdict handling |

Unmapped numbers and unnumbered text use `allow`. The two exact unsafe samples built into Guard's capability validation receive their expected positive verdicts so the **Validate** buttons can exercise both outcomes. The mock unwraps Guard's classifier request before matching, so the key comes from the user text on input or the assistant text on output.

Select your demo cluster's kubectl context and run these commands from the repository root. The ConfigMap name changes when `mapping.json` changes, which rolls the classifier Pod onto the new mapping.

```sh
kubectl -n mt-demo-v2 apply -k deploy/local-k8s/fake-models
kubectl -n mt-demo-v2 rollout status deployment/fake-llm-guard --timeout=60s
```

## Call the services directly from your Mac

Run the forwards in separate terminals with the same `KUBECONFIG`.

```sh
kubectl -n mt-demo-v2 port-forward service/fake-llm-echo 38097:8097
kubectl -n mt-demo-v2 port-forward service/fake-llm-guard 38098:8097
```

```sh
curl -fsS http://127.0.0.1:38097/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"fake-echo","messages":[{"role":"user","content":"  Hello, 你好  "}]}' \
  | jq -r '.choices[0].message.content'

curl -fsS http://127.0.0.1:38098/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"fake-guard-pii","messages":[{"role":"user","content":"2: hello"}]}' \
  | jq -r '.choices[0].message.content'
```

The first call returns the supplied text with spaces intact. The second returns `{"verdict":"pii"}`.

## Connect the Guard classifiers to `test3`

1. As platform admin in the Controller on port `38081`, open **Settings → Providers** (`/settings/providers`). Register **Custom OpenAI-compatible** with the Guard classifiers base URL from the table. Leave the API key blank. Test the connection.
2. In **Settings → Models** (`/settings/models`), register `fake-guard-jailbreak` with the **OpenAI-compatible jailbreak judge** profile and `fake-guard-pii` with **OpenAI-compatible PII judge**. Test both models.
3. In **Settings → Protection Capabilities** (`/settings/protection-capabilities`), assign `fake-guard-jailbreak` to **Jailbreak detection / Input** and `fake-guard-pii` to **Semantic PII / Input and Output**. Use **Configure by stage** when testing a single PII stage. **Save** each assignment, then **Validate** every saved stage. The Default testing Runner runs these probes. Review the saved draft as a whole before granting it to a dedicated Project.
4. Once the `test3` pool is ready with the credentials described below, open **Projects → test3 → Configure Runner → Configure model access**, choose **Validated configuration**, select the validated draft as **Validated source**, review its bindings, and click **Apply Model policy**. The dedicated Project can use that draft directly. [Group Model policy implementation](../../../controller/server/model-config/group-runtime.ts)
5. Sign in as a business user with write access to `test3`. In **Guardrail Design → Guardrails**, create a test Guardrail. For the initial examples, include an Input `model/classifier` Rule with **Jailbreak detection** and action **Block**, plus a `model/classifier` Rule with **Semantic PII** and action **Transform**. Choose Input, Output, or both for the PII Rule. The bundled **Prompt & Instruction Attacks** and **PII (Semantic)** Policies contain these Rules. For a small, deterministic suite, create a Policy under **Guardrail Design → Policy Library → Create Policy** and give each Rule a numbered acceptance case. The mock's numbered scenarios are independent of the shipped Policies' real-content test suites. [Policy authoring and test cases](../../../docs/document/en/operator/03-create-policy.mdx)
6. Use **Run tests** with model-backed Rules included. Give output tests an explicit assistant response such as `2: hello`. The test runner calls the configured classifier; the test supplies the response text to inspect. Publish a Guardrail version when ready for API traffic.

### Pool authentication prerequisite

Configure `default` and `test3` in both Controller token maps, using a distinct token for each pool and role. The control map is configured under `security.poolAuthentication` and the HTTP map under `security.runnerHttpAuthentication`. The chart configures the default Runner. For the separately provisioned `test3` Runner, set `GUARD_RUNNER_CONTROL_TOKEN` and `GUARD_CONTROLLER_HTTP_TOKEN` from the matching Secret keys for that pool. The Runner uses its control token for gRPC, model credential requests and telemetry. The Controller uses the HTTP token to call the Runner. [Chart values and rollout procedure](../../../charts/tali-guard/README.md#runner-pool-credentials)

After changing credentials, restart the affected workloads and confirm both pools are ready before validating or granting Models.

## Send API traffic through Guard with Echo as the upstream

1. In `test3`, go to **Integration → Endpoints → Add endpoint**, select **TaskLattice Guard for LiteLLM**, then issue an Endpoint credential. Under **Integration → Routers**, use **Create Router** to attach that Endpoint and route to the published Guardrail version. Submit with **Review & submit** and apply the change under **Change Requests**.
2. Create a Kubernetes Secret `test3-litellm-guard` in `mt-demo-v2` with `api-base` set to `http://runner-test3.mt-demo-v2.svc.cluster.local:8091/runtime/v1/endpoints/<endpoint-id>` and `api-key` set to the issued Endpoint credential. Use the Endpoint ID shown in the Controller. Create a separate upstream Secret with a placeholder value for the chart's required key.

   ```sh
   kubectl -n mt-demo-v2 create secret generic fake-llm-echo-upstream \
     --from-literal=api-key=local-test
   ```

3. Enable the optional LiteLLM gateway in the same Helm release with the overlay below and a compatible TaskLattice LiteLLM image available to kind. Use `helm upgrade mt-demo-v2 charts/tali-guard -n mt-demo-v2 --reuse-values -f <litellm-values.yaml>`. The existing release must have `security.bootstrap.enabled: true`. The gateway's chart will configure Guard callbacks for pre-call and post-call inspection. [LiteLLM chart setup, image compatibility, and gateway credentials](../../../charts/tali-guard/litellm-provider.md)

   ```yaml
   litellm-provider:
     enabled: true
     service:
       type: ClusterIP
     guard:
       existingSecret: test3-litellm-guard
     model:
       name: guarded-model
       upstream:
         apiBase: http://fake-llm-echo.mt-demo-v2.svc.cluster.local:8097/v1
         existingSecret: fake-llm-echo-upstream
         model: fake-echo
   ```

4. Forward the gateway with `kubectl -n mt-demo-v2 port-forward service/mt-demo-v2-litellm 38083:38083`. Call its Chat Completions endpoint with a LiteLLM gateway key. The `master-key` in `mt-demo-v2-litellm-init` is the local administrator credential. Keep that key and the Guard Endpoint credential private.

   ```sh
   curl -sS http://127.0.0.1:38083/v1/chat/completions \
     -H "Authorization: Bearer $LITELLM_API_KEY" \
     -H 'Content-Type: application/json' \
     -d '{"model":"guarded-model","messages":[{"role":"user","content":"0: hello"}]}'
   ```

   Repeat with `1: hello`, `2: hello`, and `3: hello`. For a test of output redaction, enable the Semantic PII Rule on Output only. Then Echo receives `2: hello` and returns it as the raw assistant reply, which Guard redacts before delivery.

## Implementation references

- [Mock request parsing, prefix mapping and Chat Completions response](server.py)
- [Deployment and Service definitions](workloads.yaml) and [ConfigMap generation](kustomization.yaml)
- [Runner classifier adapters](../../../runner/toolkit/safety/providers.py) and [capability smoke samples](../../../runner/capability_validation.py)
- [Controller model validation](../../../controller/server/model-config/service.ts) and [capability binding definitions](../../../controller/shared/guardrail-catalog.ts)
