import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as controllerApi from '@/lib/controller-api';
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeLogInteraction } from "@/lib/api";

import { buildTraceForest } from "@/components/execution-trace";
import { RuntimeCheckpoint, RuntimeLogSheet } from "@/components/runtime-log-sheet";
import { CheckpointHistory } from "./logs";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values?.version === undefined ? key : `${key} ${values.version}`,
    i18n: { language: "en-US", exists: () => false },
  }),
}));

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

const interaction: RuntimeLogInteraction = {
  id: "runtime-log-1",
  created_at: "2026-08-15T05:00:00Z",
  completed_at: "2026-08-15T05:00:01Z",
  guardrail_id: "guardrail-1",
  guardrail_version: "20260904-030000.003Z",
  router_id: "router-1",
  endpoint_id: null,
  protocol: "openai",
  outcome: "block",
  capture_level: "trace",
  entries: [
    {
      id: "entry-input",
      trace_id: "trace-input",
      created_at: "2026-08-15T05:00:00Z",
      phase: "input",
      outcome: "allow",
      action: "pass",
      risk: null,
      latency_ms: 5,
      timed_out: false,
      detail: "Inbound request approved",
      content_before: null,
      content_after: null,
      content_available: true,
      findings: [],
      steps: [],
    },
    {
      id: "entry-output",
      trace_id: "trace-output",
      created_at: "2026-08-15T05:00:01Z",
      phase: "output",
      outcome: "block",
      action: "block",
      risk: "sensitive_data",
      latency_ms: 8,
      timed_out: false,
      detail: "Outbound response blocked",
      content_before: null,
      content_after: null,
      content_available: true,
      findings: [],
      steps: [],
    },
  ],
};

const baseProps = {
  interactions: [interaction],
  loading: false,
  error: null,
  onInspect: vi.fn(),
  guardrailName: () => "Runtime Guardrail",
  routerName: () => "Runtime Router",
};

describe('request checkpoint browsing', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('automatically loads the first checkpoint and loads the next page without a second click', async () => {
    const event = (id: string): controllerApi.RuntimeEvent => ({
      id, occurredAt: interaction.created_at, requestId: interaction.id, runnerId:'runner',
      guardrailId:interaction.guardrail_id,guardrailVersion:interaction.guardrail_version,
      routerId:interaction.router_id,endpointId:null,direction:'incoming',decision:'allow',durationMs:1,
      metadata:{runtimeLogCaptured:true,captureLevel:'trace'},
    });
    const list = vi.spyOn(controllerApi,'listRuntimeEvents').mockImplementation(async (_limit, filters) => filters?.cursor
      ? {items:[event('older-checkpoint')],nextCursor:null}
      : {items:[event('first-checkpoint'),event('second-checkpoint')],nextCursor:'older'});
    const detail = vi.spyOn(controllerApi,'getRuntimeEvent').mockImplementation(async id => event(id));
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><RuntimeLogSheet requestId={interaction.id} guardrailId={interaction.guardrail_id} open admin guardrailName={baseProps.guardrailName} routerName={baseProps.routerName} onOpenChange={() => {}} /></QueryClientProvider>);
    await screen.findByRole('button',{name:/first-checkpoint/});
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(1));
    expect(detail).toHaveBeenCalledWith('first-checkpoint',expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('button',{name:'eventPagination.next'}));
    await waitFor(() => expect(detail).toHaveBeenCalledWith('older-checkpoint', expect.any(AbortSignal)));
    expect(list).toHaveBeenLastCalledWith(100,expect.objectContaining({requestId:interaction.id,guardrailId:interaction.guardrail_id,cursor:'older'}),expect.any(AbortSignal));
    expect(detail).toHaveBeenCalledTimes(2);
    client.clear();
  });
  it('loads an uncaptured finding checkpoint without requiring it on the current list page', async () => {
    vi.spyOn(controllerApi, 'listRuntimeEvents').mockResolvedValue({ items: [], nextCursor: null });
    const detail = vi.spyOn(controllerApi, 'getRuntimeEvent').mockResolvedValue({
      id: 'finding-event', requestId: interaction.id, guardrailId: interaction.guardrail_id,
      guardrailVersion: interaction.guardrail_version, occurredAt: interaction.created_at,
      runnerId: 'runner', routerId: null, endpointId: null, direction: 'incoming', decision: 'block', durationMs: 5,
      metadata: { trace: [{ id: 'span', name: 'Retained metadata', status: 'block', durationMs: 5 }] },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><RuntimeLogSheet requestId={interaction.id} guardrailId={interaction.guardrail_id} checkpointId="finding-event" open admin guardrailName={baseProps.guardrailName} routerName={baseProps.routerName} onOpenChange={() => {}} /></QueryClientProvider>);
    expect(await screen.findByText('Retained metadata')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'logs.requestContent' }));
    expect(screen.getByText('logs.contentNotCaptured')).toBeTruthy();
    expect(detail).toHaveBeenCalledWith('finding-event', expect.any(AbortSignal));
    client.clear();
  });

  it('opens metadata only, requests body on expansion, and releases it when switching checkpoints', async () => {
    vi.spyOn(controllerApi, 'listRuntimeEvents').mockResolvedValue({ items: [], nextCursor: null });
    const detail = vi.spyOn(controllerApi, 'getRuntimeEvent').mockImplementation(async (id, _signal, includeContent) => ({
      id, requestId: interaction.id, guardrailId: interaction.guardrail_id,
      occurredAt: interaction.created_at, runnerId: 'runner', guardrailVersion: interaction.guardrail_version,
      routerId: null, endpointId: null, direction: 'incoming', decision: 'allow', durationMs: 1,
      metadata: { contentAvailable: true, ...(includeContent ? { contentBefore: [{ id: 'body', text: 'Lazy body', role: 'user', source: 'user' }] } : {}) },
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const props = { requestId: interaction.id, guardrailId: interaction.guardrail_id, open: true, admin: true, guardrailName: baseProps.guardrailName, routerName: baseProps.routerName, onOpenChange: () => {} };
    const view = render(<QueryClientProvider client={client}><RuntimeLogSheet {...props} checkpointId="one" /></QueryClientProvider>);
    const originalRequest = await screen.findByRole('button', { name: 'logs.requestContent' });
    expect(detail.mock.calls.map(call => [call[0], call[2]])).toEqual([['one', undefined]]);
    expect(screen.queryByText('Lazy body')).toBeNull();
    fireEvent.click(originalRequest);
    expect(await screen.findByText('Lazy body')).toBeTruthy();
    expect(detail.mock.calls.map(call => [call[0], call[2]])).toEqual([['one', undefined], ['one', true]]);
    fireEvent.click(screen.getByRole('button', { name: 'logs.requestContent' }));
    fireEvent.click(screen.getByRole('button', { name: 'logs.requestContent' }));
    expect(detail).toHaveBeenCalledTimes(2);
    view.rerender(<QueryClientProvider client={client}><RuntimeLogSheet {...props} checkpointId="two" /></QueryClientProvider>);
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(3));
    const toggle = await screen.findByRole('button', { name: 'logs.requestContent' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Lazy body')).toBeNull();
    expect(detail.mock.calls[2]?.[2]).toBeUndefined();
    view.unmount();
    client.clear();
  });

  it('shows an unavailable state for an expired request', async () => {
    vi.spyOn(controllerApi, 'listRuntimeEvents').mockResolvedValue({ items: [], nextCursor: null });
    const detail = vi.spyOn(controllerApi, 'getRuntimeEvent');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><RuntimeLogSheet requestId="expired" open admin guardrailName={baseProps.guardrailName} routerName={baseProps.routerName} onOpenChange={() => {}} /></QueryClientProvider>);
    expect(await screen.findByText('logs.recordUnavailable')).toBeTruthy();
    expect(detail).not.toHaveBeenCalled();
    client.clear();
  });

  it('offers retry after a detail failure and rejects a checkpoint from another request', async () => {
    vi.spyOn(controllerApi, 'listRuntimeEvents').mockResolvedValue({ items: [], nextCursor: null });
    const detail = vi.spyOn(controllerApi, 'getRuntimeEvent').mockRejectedValueOnce(new Error('Temporary detail failure')).mockResolvedValue({
      id: 'wrong-event', requestId: 'different-request', guardrailId: interaction.guardrail_id,
      metadata: { runtimeLogCaptured: true },
    } as controllerApi.RuntimeEvent);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><RuntimeLogSheet requestId={interaction.id} checkpointId="wrong-event" open admin guardrailName={baseProps.guardrailName} routerName={baseProps.routerName} onOpenChange={() => {}} /></QueryClientProvider>);
    expect(await screen.findByText('Temporary detail failure')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByText('logs.checkpointMismatch')).toBeTruthy();
    expect(detail).toHaveBeenCalledTimes(2);
    client.clear();
  });

});

describe("CheckpointHistory", () => {
  afterEach(cleanup);

  it("renders one traffic checkpoint per inbound and outbound log entry", () => {
    render(<CheckpointHistory {...baseProps} />);

    expect(screen.getByText("Inbound request approved")).toBeTruthy();
    expect(screen.getByText("Outbound response blocked")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByText(/policy \/ version \/ published/i)).toBeNull();
    expect(screen.queryByText(/validation completed/i)).toBeNull();
  });

  it("renders only checkpoints supplied by the shared runtime query", () => {
    render(<CheckpointHistory {...baseProps} interactions={[{ ...interaction, entries: [interaction.entries[0]!] }]} />);

    expect(screen.getByText("Inbound request approved")).toBeTruthy();
    expect(screen.queryByText("Outbound response blocked")).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });
});


describe("runtime detail", () => {
  afterEach(cleanup);
  const step = (id: string, parent_id?: string) => ({ id, parent_id, name: id, kind: "action", outcome: "allow", latency_ms: 4 } as RuntimeLogInteraction["entries"][number]["steps"][number]);

  it("uses parent links even when children arrive first, and retains orphan/cyclic spans", () => {
    const forest = buildTraceForest([step("child", "root"), step("root"), step("orphan", "missing"), step("a", "b"), step("b", "a")]);
    expect(forest.map((node) => node.step.id)).toEqual(["root", "orphan", "a", "b"]);
    expect(forest[0]?.children[0]?.step.id).toBe("child");
  });

  it("labels model text and supports branch collapse and span inspection", () => {
    const entry = { ...interaction.entries[1]!, steps: [step("root"), { ...step("child", "root"), detail: "Recorded evaluation detail" }], content_before: [{ id: "text", role: "model_output", source: "model_output", text: "Model response body", truncated: false }] };
    render(<RuntimeCheckpoint entry={entry} admin />);
    expect(screen.getByRole("heading", { name: "logs.modelOutput" })).toBeTruthy();
    expect(screen.getByText("Model response body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "logs.collapseSpan" }));
    expect(screen.queryByText("child")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "logs.expandSpan" }));
    fireEvent.click(screen.getAllByRole("button", { name: "logs.inspectSpan" })[1]!);
    expect(screen.getByText("Recorded evaluation detail")).toBeTruthy();
  });

  it("keeps captured content hidden from non-admins and explains absent traces", () => {
    render(<RuntimeCheckpoint entry={{ ...interaction.entries[1]!, content_before: [{ id: "text", role: "model_output", source: "model_output", text: "Private body", truncated: false }] }} admin={false} />);
    expect(screen.queryByText("Private body")).toBeNull();
    expect(screen.getByText("logs.traceEmpty")).toBeTruthy();
  });
});
