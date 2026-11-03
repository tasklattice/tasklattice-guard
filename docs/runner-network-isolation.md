# Runner pool network isolation

`networkPolicy.runnerIsolation.enabled=true` renders an ingress/egress policy for each chart Runner pool. Each policy selects that release's Runner pods and exact pool label. Unlisted destinations and ingress peers are denied by an enforcing NetworkPolicy CNI, subject to Kubernetes policy union and node/host-network exceptions.

The default remains off. Existing base policies limit Controller gRPC and bundled Redis ingress; they do not restrict Runner ingress or egress. This addition does not change the current demo deployment.

## Allowed connections

| Direction | Default allowed peer | Ports |
| --- | --- | --- |
| Runner ingress | Same namespace/release Controller pods | TCP 8091 |
| Runner egress | Same namespace/release Controller pods | TCP 8080, TCP 9090 |
| Runner egress | Same namespace/release bundled Redis, if enabled | TCP 6379 |
| Runner egress | Configured DNS peers; initially kube-system/kube-dns | TCP 53, UDP 53 |

Other Runner pools, the PostgreSQL service, arbitrary namespace pods, metadata endpoints and external Providers are not default egress exceptions. Controller and bundled Redis remain shared destinations. Application authentication and pool-scoped credential checks still apply to permitted connections. A compromised Runner can use its permitted shared services; these policies do not create per-group Redis ACLs or database isolation.

Public runtime traffic must arrive from an explicitly configured gateway, and metrics scraping needs an explicit peer. Both use `ingressPeers` on TCP 8091. Node-local DNS, external Redis, model Providers and OTLP collectors need explicit peers/ports. An empty peer object, an egress rule with no destination/port, or an unknown pool key fails chart validation. An explicitly broad selector is an administrator's broad grant; the chart cannot infer whether it is appropriate. Kubernetes validates CIDR and selector syntax at admission.

```yaml
networkPolicy:
  enabled: true
  runnerIsolation:
    enabled: true
    ingressPeers:
      - namespaceSelector:
          matchLabels: { kubernetes.io/metadata.name: gateway }
        podSelector:
          matchLabels: { app: trusted-runtime-gateway }
    poolEgress:
      default:
        - to: [{ ipBlock: { cidr: 192.0.2.9/32 } }]
          ports: [{ protocol: TCP, port: 443 }]
```

The Provider IP above is a documentation address; replace it with a real authorized destination. Native NetworkPolicy does not support DNS names. Account for address changes, service DNAT behavior and IPv4/IPv6 in the deployment's CNI. Restrict cluster RBAC so tenant workloads cannot relabel themselves as Controller/gateway pods or add another policy that permits traffic. Keep pool control/HTTP credentials distinct even when network restrictions are enabled.

## Verification boundary

Rendering tests verify exact pool selectors, both default-deny directions, required shared-service/DNS exceptions, per-pool external exceptions and invalid configuration rejection. They do not exercise packets or certify a CNI. A deployment test must verify Controller/Redis/DNS/authorized Provider access, external gateway routing and monitoring, denial between pools and to PostgreSQL/metadata, and behavior after policy restart/rollout. NetworkPolicy egress does not provide a permanent infrastructure fence for a paused or compromised host and is not accepted as move-fencing evidence by this feature.

On 1 November 2026 the local cluster inventory showed `kindnet` and `kube-proxy` DaemonSets and only the base Controller/Redis policies. A direct TCP connection from the `default` Runner pool to the `group-demo` Runner on port 8091 succeeded. This proves current cross-pool network reachability, not access to authenticated runtime material. Per-pool policies had not been installed; CNI enforcement was not certified. Do not claim network isolation from a successful Helm render or a policy object's existence.
