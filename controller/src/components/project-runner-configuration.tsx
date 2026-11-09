import { useRef, useState, type RefObject } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, MoreHorizontal, Server } from "lucide-react";
import { EntitySheet } from "@/components/entity-sheet";
import { ErrorNotice } from "@/components/product-shell";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { GroupModelConfigurationSheet } from "@/components/group-model-configuration";
import { projectGroupsEn, projectGroupsZh } from "@/project-groups-i18n";
import { getProjectRunner, configureProjectRunner } from "@/lib/projects-api";
import { updateRunnerPoolConnectivity } from "@/lib/project-groups-api";
import { runnerPoolOriginSchema, type ProjectRunnerView } from "../../shared/project-groups";
import type { Project } from "../../shared/projects";
import "./project-runner-configuration.scss";

const key = (id: string) => ["project-runner", id] as const;
type View = "overview" | "connectivity" | "dedicated" | "shared" | "models";

export function ProjectRunnerConfiguration({ project, onClose, returnFocusRef }: {
  project: Project; onClose: () => void; returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<View>("overview");
  const [reviewed, setReviewed] = useState<ProjectRunnerView | null>(null);
  const [saved, setSaved] = useState(false);
  const query = useQuery({
    queryKey: key(project.id), queryFn: ({ signal }) => getProjectRunner(project.id, signal),
    retry: false,
  });
  const current = !query.isError ? query.data : undefined;
  const data = view === "overview" ? current : reviewed;
  function chooseView(next: View) {
    if (next !== "overview" && view === "overview") setReviewed(current ?? null);
    if (next === "overview") setReviewed(null);
    setView(next);
  }
  const scope = data?.groupId === "default"
    ? t("projects.sharedScope", { count: data.modelScope.projectCount })
    : data && (data.modelScope.projectCount > 1 || data.modelScope.poolCount > 1)
      ? t("projects.multipleScope", { projects: data.modelScope.projectCount, pools: data.modelScope.poolCount })
      : t("projects.dedicatedScope", { project: project.name });
  // Each task replaces the sheet, so dialogs and focus traps never stack.
  if (data && view === "models") return <GroupModelConfigurationSheet
    group={{ id: data.groupId, name: data.pool?.name ?? project.name }}
    copy={i18n.language.startsWith("zh") ? projectGroupsZh : projectGroupsEn}
    scopeDescription={scope} onDismiss={onClose} returnFocusRef={returnFocusRef}
    onClose={() => chooseView("overview")} />;
  if (data && (view === "connectivity" || view === "dedicated" || view === "shared")) return <ConnectionForm
    data={data} view={view} scope={scope} onChoose={chooseView} onDismiss={onClose} returnFocusRef={returnFocusRef}
    onBack={() => chooseView("overview")}
    onSaved={() => { setSaved(true); chooseView("overview"); }} />;
  return <EntitySheet open width="md" title={project.name} eyebrow={t("projects.configureRunner")}
    returnFocusRef={returnFocusRef} description={t("projects.runnerDescription")}
    onOpenChange={open => { if (!open) onClose(); }} footer={null}>
    {query.isPending && <p role="status">{t("common.loading")}</p>}
    {query.error && <><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()}>{t("projects.reloadRunner")}</Button></>}
    {data && <div className="project-runner-detail">
      {saved && <p role="status" className="project-runner-saved">{t("projects.runnerSaved")}</p>}
      <section>
        <div className="project-runner-heading">
          <Server size={20} aria-hidden="true" /><h3>{data.pool?.name ?? t("projects.noRunners")}</h3>
          {data.pool?.isDefault && <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={t("projects.runnerOptions")}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => chooseView("dedicated")}>{t("projects.switchDedicatedRunner")}</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>}
        </div>
        {data.pool ? <>
          <p className="project-runner-muted">{data.pool.isDefault ? t("projects.sharedRunner") : t("projects.dedicatedRunner")}</p>
          <div className="project-runner-status">
            <span>{data.pool.connectedCount ? t("projects.connectedRunners", { count: data.pool.connectedCount }) : t("projects.noConnectedRunner")}</span>
            <Link to="/settings/runner" onClick={onClose}>{t("projects.viewInstances")}</Link>
          </div>
        </> : <>
          <p className="project-runner-muted">{t("projects.noRunnerHint")}</p>
          <Button onClick={() => chooseView("shared")}>{t("projects.allocateRunner")}</Button>
        </>}
      </section>
      {data.pool && <>
        <section>
          <div className="project-runner-setting-heading"><h3>{t("projects.runnerConnection")}</h3>
            <Button variant="link" size="sm" onClick={() => chooseView("connectivity")}>{t("projects.editConnection")}</Button></div>
          <dl className="project-runner-facts">
            <div><dt>{t("projects.runnerInternalUrl")}</dt><dd>{data.pool.runtimeUrl ?? t("projects.inheritedRunnerUrl")}</dd></div>
            <div><dt>{t("projects.runnerPublicUrl")}</dt><dd>{data.pool.publicUrl ?? t("projects.runnerUrlUnset")}</dd></div>
          </dl>
        </section>
        <section>
          <div className="project-runner-setting-heading"><h3>{t("projects.runnerModelAccess")}</h3>
            <Button variant="link" size="sm" onClick={() => chooseView("models")}>{t("projects.configureModelAccess")}</Button></div>
          <p className="project-runner-muted">{scope}</p>
        </section>
      </>}
    </div>}
  </EntitySheet>;
}

function ConnectionForm({ data, view, scope, onChoose, onBack, onSaved, onDismiss, returnFocusRef }: {
  data: ProjectRunnerView; view: "connectivity" | "dedicated" | "shared"; scope: string;
  onChoose: (view: "shared" | "dedicated") => void;
  onDismiss: () => void; returnFocusRef: RefObject<HTMLButtonElement | null>;
  onBack: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [runtimeUrl, setRuntimeUrl] = useState(view === "connectivity" ? data.pool?.runtimeUrl ?? "" : "");
  const [publicUrl, setPublicUrl] = useState(view === "connectivity" ? data.pool?.publicUrl ?? "" : "");
  const form = useRef<HTMLFormElement>(null);
  const sharedConnection = view === "connectivity" && data.pool?.isDefault;
  const originValid = (value: string) => runnerPoolOriginSchema.safeParse(value.trim()).success;
  const valid = view === "shared" || ((runtimeUrl.trim() ? originValid(runtimeUrl) : sharedConnection) && (!publicUrl.trim() || originValid(publicUrl)));
  const changed = view !== "connectivity" || runtimeUrl.trim() !== (data.pool?.runtimeUrl ?? "") || publicUrl.trim() !== (data.pool?.publicUrl ?? "");
  const mutation = useMutation({
    mutationFn: async () => {
      if (view === "connectivity") return updateRunnerPoolConnectivity(data.pool!.id, { runtimeUrl: runtimeUrl.trim() || null, publicUrl: publicUrl.trim() || null });
      const version = { expectedGroupId: data.groupId, expectedPoolId: data.pool?.id ?? null };
      return configureProjectRunner(data.projectId, view === "shared" ? { ...version, mode: "shared" } : {
        ...version, mode: "dedicated", runtimeUrl: runtimeUrl.trim(), publicUrl: publicUrl.trim() || null,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: key(data.projectId) }),
        client.invalidateQueries({ queryKey: ["projects"] }),
        client.invalidateQueries({ queryKey: ["resources", "runner-pools"] }),
      ]);
      onSaved();
    },
  });
  const title = !data.pool ? t("projects.allocateRunner") : t(view === "shared" ? "projects.useSharedRunner" : view === "dedicated" ? "projects.registerDedicatedRunner" : "projects.editConnection");
  return <EntitySheet open width="md" title={title} eyebrow={data.projectName}
    description={view === "dedicated" ? t("projects.registrationOnly") : view === "shared" ? t("projects.assignSharedHint") : t("projects.connectionHint")}
    returnFocusRef={returnFocusRef} closeDisabled={mutation.isPending} onOpenChange={open => { if (!open && !mutation.isPending) onDismiss(); }}
    footer={<><Button variant="outline" disabled={mutation.isPending} onClick={onBack}>{t("common.cancel")}</Button>
      <Button disabled={!valid || !changed || mutation.isPending} onClick={() => form.current?.requestSubmit()}>{mutation.isPending ? t("common.saving") : t(view === "dedicated" ? "projects.registerDedicatedRunner" : view === "shared" ? "projects.useSharedRunner" : "common.save")}</Button></>}>
    <form ref={form} className="project-runner-form" onSubmit={event => { event.preventDefault(); if (valid && changed && !mutation.isPending) mutation.mutate(); }}>
      <Button variant="ghost" className="project-runner-back" disabled={mutation.isPending} onClick={onBack}><ArrowLeft aria-hidden="true" />{t("projects.backToRunner")}</Button>
      {mutation.error && <ErrorNotice error={mutation.error} />}
      {!data.pool && <fieldset className="project-runner-choice">
        <legend>{t("projects.runnerAllocation")}</legend>
        <label><input type="radio" name="runner-mode" checked={view === "shared"} disabled={mutation.isPending} onChange={() => onChoose("shared")} /><span>{t("projects.sharedRunner")}<small>{t("projects.sharedChoiceHint")}</small></span></label>
        <label><input type="radio" name="runner-mode" checked={view === "dedicated"} disabled={mutation.isPending} onChange={() => onChoose("dedicated")} /><span>{t("projects.dedicatedRunner")}<small>{t("projects.dedicatedRunnerHint", { project: data.projectName })}</small></span></label>
      </fieldset>}
      {(view === "shared" || sharedConnection) && <p className="project-runner-impact">{view === "shared" ? t("projects.sharedAssignmentImpact") : scope}</p>}
      {view === "dedicated" && <>
        <dl className="project-runner-facts"><div><dt>{t("projects.runnerInstanceName")}</dt><dd>runner-{data.projectName}-0</dd></div></dl>
        <p className="project-runner-impact">{t("projects.dedicatedAssignmentImpact")}</p>
      </>}
      {view !== "shared" && <>
        <label htmlFor="runner-internal">{t("projects.runnerInternalUrl")}</label>
        <Input id="runner-internal" value={runtimeUrl} disabled={mutation.isPending} aria-describedby="runner-internal-hint" aria-invalid={Boolean(runtimeUrl && !originValid(runtimeUrl))} onChange={e => setRuntimeUrl(e.target.value)} placeholder={view === "dedicated" ? `http://runner-${data.projectName}:8091` : undefined} />
        <p id="runner-internal-hint" className="project-runner-muted">{t(sharedConnection ? "projects.sharedOriginHint" : "projects.originHint")}</p>
        <label htmlFor="runner-public">{t("projects.runnerPublicUrlOptional")}</label>
        <Input id="runner-public" value={publicUrl} disabled={mutation.isPending} aria-describedby="runner-public-hint" aria-invalid={Boolean(publicUrl && !originValid(publicUrl))} onChange={e => setPublicUrl(e.target.value)} />
        <p id="runner-public-hint" className="project-runner-muted">{t("projects.publicOriginHint")}</p>
      </>}
    </form>
  </EntitySheet>;
}
