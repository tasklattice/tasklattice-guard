import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, MoreHorizontal, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { DuplicateGuardrailSheet } from './guardrail-duplicate';
import { DeleteGuardrailSheet, type GuardrailDeletionConfirmation } from './guardrail-delete-sheet';
import { queryKeys } from '@/features/query-keys';
import { deleteGuardrail, getGuardrailDeletionImpact, type Guardrail } from '@/lib/api';
import { useRoutingText } from './traffic-routing/form';

export function GuardrailRowActions({ guardrail }: { guardrail: Guardrail }) {
  const t = useRoutingText();
  const [action, setAction] = useState<'delete' | 'duplicate' | null>(null);
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-11" aria-label={`${t('操作', 'Actions')}: ${guardrail.name}`}><MoreHorizontal className="size-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={event => { if (action) event.preventDefault(); }}>
        <DropdownMenuItem onSelect={() => setAction('duplicate')}><Copy />{t('创建副本', 'Duplicate')}</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => setAction('delete')}><Trash2 />{t('删除', 'Delete')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {action === 'duplicate' && <DuplicateGuardrailSheet id={guardrail.id} name={guardrail.name} close={() => setAction(null)} />}
    {action === 'delete' && <DeleteAction guardrail={guardrail} close={() => setAction(null)} />}
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
