import { useTranslation } from "react-i18next";
import { NativeSelect as CarbonNativeSelect } from "@/components/ui/native-select";
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
  draftRevision: number;
  versions: Array<{ version: string; status?: string; hasSourceSnapshot?: boolean }>;
  [key: string]: unknown;
};

type DuplicateSource = { sourceVersion: string; sourceDraftRevision?: never } | { sourceDraftRevision: number; sourceVersion?: never };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-2 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}
function NativeSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <CarbonNativeSelect {...props} className={`h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${props.className ?? ''}`} />;
}

export function DuplicateGuardrailSheet({ id, name, close, onDuplicated }: { id: string; name: string; close: () => void; onDuplicated?: (copy: GuardrailDetail) => void }) {
  const { t: uiText } = useTranslation();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['duplicate-source', id], queryFn: async () => {
    const response = await fetch(`/api/v1/guardrails/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Unable to load Guardrail (${response.status}).`);
    return response.json() as Promise<GuardrailDetail>;
  }, staleTime: Infinity });
  const [copyName, setCopyName] = useState(`${name} - copy`);
  // "draft" or "version:<id>": the source is always chosen explicitly.
  const [source, setSource] = useState('draft');
  const [submission, setSubmission] = useState<{ name: string; source: DuplicateSource; key: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      const frozen = submission ?? { name: copyName.trim(), source: source.startsWith('version:') ? { sourceVersion: source.slice('version:'.length) } : { sourceDraftRevision: query.data!.draftRevision }, key: crypto.randomUUID() };
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
  const published = (query.data?.versions ?? []).filter(version => !version.status || version.status === "ready");
  const missingSnapshot = source.startsWith('version:') && published.find(version => `version:${version.version}` === source)?.hasSourceSnapshot === false;
  const unavailable = missingSnapshot;
  return <EntitySheet open onOpenChange={open => { if (!open && !mutation.isPending) close(); }} closeDisabled={mutation.isPending} eyebrow={uiText("uiCopy.guardrail")} title={uiText("uiCopy.duplicateGuardrail")} description={uiText("uiCopy.copyConfigurationAndPinnedDependenciesIntoAnIndependentDraft")} footer={<><Button variant="outline" onClick={close} disabled={mutation.isPending}>{uiText("uiCopy.cancel")}</Button><Button variant="create" disabled={!query.data || !copyName.trim() || unavailable || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? uiText("uiCopy.duplicating") : mutation.isError ? uiText("uiCopy.retryDuplicate") : uiText("uiCopy.createCopy")}</Button></>}>
    <div className="grid gap-5">
      {query.error && <><ErrorNotice error={query.error} /><Button onClick={() => void query.refetch()}>{uiText("uiCopy.retry")}</Button></>}
      {query.isPending && <p role="status">{uiText("uiCopy.loadingSource")}</p>}
      <Field label={uiText("uiCopy.copyName")}><Input className="field:min-h-11" value={copyName} disabled={Boolean(submission)} onChange={event => setCopyName(event.target.value)} /></Field>
      <Field label={uiText("uiCopy.copySource")}><NativeSelect value={source} disabled={Boolean(submission)} onChange={event => setSource(event.target.value)}><option value="draft">{uiText("uiCopy.currentDraftR")}{query.data?.draftRevision ?? '—'}</option>{published.map(version => <option key={version.version} value={`version:${version.version}`} disabled={version.hasSourceSnapshot === false}>{uiText("uiCopy.publishedVersion")}{" "}{version.version}</option>)}</NativeSelect></Field>
      {missingSnapshot && <p role="alert">{uiText("uiCopy.thePublishedVersionHasNoCompleteSourceSnapshotExplicitly")}</p>}
      {mutation.error && <ErrorNotice error={mutation.error} />}
      {submission && mutation.isError && <p className="text-sm">{uiText("uiCopy.theSourceAndNameAreFrozenRetryingReturnsThe")}</p>}
    </div>
  </EntitySheet>;
}
