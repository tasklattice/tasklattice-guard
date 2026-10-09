import { useTranslation } from "react-i18next";
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, MoreHorizontal, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from './ui/dropdown-menu';
import { DuplicateGuardrailSheet } from './guardrail-duplicate';
import { DeleteGuardrailSheet, type GuardrailDeletionConfirmation } from './guardrail-delete-sheet';
import { ExportGuardrailSheet } from './guardrail-export-sheet';
import { queryKeys } from '@/features/query-keys';
import { deleteGuardrail, getGuardrailDeletionImpact, type Guardrail } from '@/lib/api';


export function GuardrailRowActions({ guardrail }: { guardrail: Guardrail }) {
  const { t } = useTranslation();
  const canEdit = useAuth().user?.role === 'admin';
  const [action, setAction] = useState<'delete' | 'duplicate' | 'export' | null>(null);
  const published = guardrail.status !== "needs_validation";
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-11" aria-label={`${t("routing.actions")}: ${guardrail.name}`}><MoreHorizontal className="size-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (action) event.preventDefault(); }}>
        <DropdownMenuItem disabled={!published} onSelect={() => setAction('export')}><Download />{t('guardrails.exportEllipsis')}</DropdownMenuItem>
        {!published && <DropdownMenuLabel>{t('guardrails.exportRequiresPublish')}</DropdownMenuLabel>}
        {canEdit && <DropdownMenuItem onSelect={() => setAction('duplicate')}><Copy />{t("routing.duplicate")}</DropdownMenuItem>}
        {canEdit && <DropdownMenuItem variant="destructive" onSelect={() => setAction('delete')}><Trash2 />{t("routing.delete")}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    {action === 'duplicate' && <DuplicateGuardrailSheet id={guardrail.id} name={guardrail.name} close={() => setAction(null)} />}
    {action === 'delete' && <DeleteAction guardrail={guardrail} close={() => setAction(null)} />}
    {action === 'export' && <ExportGuardrailSheet guardrailId={guardrail.id} guardrailName={guardrail.name} onClose={() => setAction(null)} />}
  </>;
}

function DeleteAction({ guardrail, close }: { guardrail: Guardrail; close: () => void }) {
  const client = useQueryClient();
  const impact = useQuery({ queryKey: queryKeys.guardrailDeletionImpact(guardrail.id), queryFn: () => getGuardrailDeletionImpact(guardrail.id), staleTime: 0 });
  const mutation = useMutation({
    mutationFn: (confirmation: GuardrailDeletionConfirmation) => deleteGuardrail(guardrail.id, confirmation),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.guardrails }),
        client.invalidateQueries({ queryKey: ['routing-guardrails'] }),
        client.invalidateQueries({ queryKey: ['traffic-routers'] }),
        client.invalidateQueries({ queryKey: queryKeys.routers }),
        client.invalidateQueries({ queryKey: queryKeys.metrics }),
        client.invalidateQueries({ queryKey: queryKeys.auditEvents }),
      ]);
      close();
    },
  });
  return <DeleteGuardrailSheet guardrail={guardrail} open impact={impact.data} loading={impact.isFetching}
    deleting={mutation.isPending} error={mutation.error ?? impact.error}
    onOpenChange={open => { if (!open && !mutation.isPending) close(); }}
    onRetry={() => { mutation.reset(); void impact.refetch(); }}
    onConfirm={confirmation => mutation.mutate(confirmation)} />;
}
