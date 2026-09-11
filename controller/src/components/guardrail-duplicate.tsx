import { queryKeys } from "@/features/query-keys";
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EntitySheet } from './entity-sheet';
import { ErrorNotice } from './product-shell';
import { Button } from './ui/button';
import { Input } from './ui/input';
import type { ReactNode, SelectHTMLAttributes } from 'react';
type GuardrailDetail = {
  id: string;
  name: string;
  activeVersion: string | null;
  draftRevision: number;
  versions: Array<{ version: string; hasSourceSnapshot?: boolean }>;
  [key: string]: unknown;
};

type DuplicateSource = { sourceVersion: string; sourceDraftRevision?: never } | { sourceDraftRevision: number; sourceVersion?: never };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-2 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}
function NativeSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${props.className ?? ''}`} />;
}

export function DuplicateGuardrailSheet({ id, name, close, onDuplicated }: { id: string; name: string; close: () => void; onDuplicated?: (copy: GuardrailDetail) => void }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['duplicate-source', id], queryFn: async () => {
    const response = await fetch(`/api/v1/guardrails/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Unable to load Guardrail (${response.status}).`);
    return response.json() as Promise<GuardrailDetail>;
  }, staleTime: Infinity });
  const [copyName, setCopyName] = useState(`${name} - copy`);
  const [source, setSource] = useState('published');
  const [submission, setSubmission] = useState<{ name: string; source: DuplicateSource; key: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      const frozen = submission ?? { name: copyName.trim(), source: source === 'published' ? { sourceVersion: query.data!.activeVersion! } : { sourceDraftRevision: query.data!.draftRevision }, key: crypto.randomUUID() };
      setSubmission(frozen);
      const response = await fetch(`/api/v1/guardrails/${encodeURIComponent(id)}/duplicate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: frozen.name, ...frozen.source, idempotencyKey: frozen.key }),
      });
      if (!response.ok) throw new Error(`Unable to duplicate Guardrail (${response.status}).`);
      return response.json() as Promise<GuardrailDetail>;
    },
    onSuccess: async copy => {
      await client.invalidateQueries({ queryKey: queryKeys.guardrails });
      await client.invalidateQueries({ queryKey: ['routing-guardrails'] });
      close();
      if (onDuplicated) onDuplicated(copy);
      // The caller can provide onDuplicated to navigate in its own router
      // context. Keeping this action context-free also makes it usable from
      // table rows and command surfaces.
    },
  });
  const missingSnapshot = query.data?.versions.find(version => version.version === query.data?.activeVersion)?.hasSourceSnapshot === false;
  const unavailable = source === 'published' && (!query.data?.activeVersion || missingSnapshot);
  return <EntitySheet open onOpenChange={open => { if (!open && !mutation.isPending) close(); }} closeDisabled={mutation.isPending} eyebrow="Guardrail" title="Duplicate Guardrail" description="Copy configuration and pinned dependencies into an independent draft. Validation, logs, Endpoint bindings and traffic weights are not copied." footer={<><Button variant="outline" onClick={close} disabled={mutation.isPending}>Cancel</Button><Button disabled={!query.data || !copyName.trim() || unavailable || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Duplicating…' : mutation.isError ? 'Retry duplicate' : 'Create copy'}</Button></>}> 
    <div className="grid gap-5">
      {query.error && <><ErrorNotice error={query.error} /><Button onClick={() => void query.refetch()}>Retry</Button></>}
      {query.isPending && <p role="status">Loading source…</p>}
      <Field label="Copy name"><Input className="min-h-11" value={copyName} disabled={Boolean(submission)} onChange={event => setCopyName(event.target.value)} /></Field>
      <Field label="Copy source"><NativeSelect value={source} disabled={Boolean(submission)} onChange={event => setSource(event.target.value)}><option value="published" disabled={missingSnapshot}>Current published version · {query.data?.activeVersion ?? '—'}</option><option value="draft">Current draft · r{query.data?.draftRevision ?? '—'}</option></NativeSelect></Field>
      {missingSnapshot && <p role="alert">The published version has no complete source snapshot. Explicitly choose the current draft, or republish the source Guardrail before duplicating.</p>}
      {unavailable && !missingSnapshot && <p role="alert">No published version. Select the current draft.</p>}
      {mutation.error && <ErrorNotice error={mutation.error} />}
      {submission && mutation.isError && <p className="text-sm">The source and name are frozen. Retrying returns the same copy.</p>}
    </div>
  </EntitySheet>;
}
