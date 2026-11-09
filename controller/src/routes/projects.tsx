import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Plus, Search } from "lucide-react";
import type { Project } from "../../shared/projects";
import {
  normalizeProjectName,
  projectNameSchema,
} from "../../shared/runner-naming";
import { ProjectRunnerConfiguration } from "@/components/project-runner-configuration";
import { EntitySheet } from "@/components/entity-sheet";
import { PageHeader, ErrorNotice } from "@/components/product-shell";
import { DirectorySelect, type DirectorySelection } from "@/components/directory-select";
import { queryKeys } from "@/features/query-keys";
import { toast } from "@/components/ui/notifications";
import {
  DirectoryPagination,
  useDirectoryPage,
} from "@/components/directory-pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listProjects,
  createProject,
  listProjectMembers,
  listMemberCandidates,
  setProjectMember,
} from "@/lib/projects-api";
import "./people-projects.scss";
export function ProjectsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const control = useDirectoryPage("projects");
  const [selected, setSelected] = useState<Project | null>(null);
  const [runnerProject, setRunnerProject] = useState<Project | null>(null);
  const runnerTrigger = useRef<HTMLButtonElement>(null);
  const membersTrigger = useRef<HTMLButtonElement>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const query = useQuery({
    queryKey: ["projects", control.query],
    queryFn: ({ signal }) => listProjects(control.query, signal),
  });
  return (
    <section className="people-projects-page">
      <PageHeader
        title={t("projects.title")}
        description={t("projects.description")}
        action={
          <Button ref={trigger} onClick={() => setCreateOpen(true)}>
            <Plus />
            {t("projects.create")}
          </Button>
        }
      />
      {query.error && <ErrorNotice error={query.error} />}
      <section className="project-list">
        <div className="project-list-toolbar">
          <div className="directory-search"><Search size={16} aria-hidden="true" />
          <Input
            aria-label={t("projects.search")}
            placeholder={t("projects.search")}
            value={control.search}
            onChange={(e) => control.setSearch(e.target.value)}
          />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("projects.newName")}</TableHead>
              <TableHead>{t("projects.runnerAllocation")}</TableHead>
              <TableHead>{t("users.user")}</TableHead>
              <TableHead>{t("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.data?.items.map((project) => (
              <TableRow key={project.id}>
                <TableCell>{project.name}</TableCell>
                <TableCell>
                  <span>{project.poolName ?? t("projects.noRunners")}</span>
                  {project.poolId && <p className="text-xs text-muted-foreground">{t(project.poolId === "default" ? "projects.sharedRunner" : "projects.dedicatedRunner")}</p>}
                </TableCell>
                <TableCell>{project.memberCount}</TableCell>
                <TableCell>
                  <div className="project-row-actions">
                  <Button variant="ghost" aria-label={`${t("projects.configureRunner")} · ${project.name}`} onClick={event => { runnerTrigger.current = event.currentTarget; setRunnerProject(project); }}>
                    {t("projects.configureRunner")}
                  </Button>
                  <Button variant="ghost" aria-label={`${t("projects.manageLocalUsers")} · ${project.name}`} onClick={event => { membersTrigger.current = event.currentTarget; setSelected(project); }}>{t("projects.manageLocalUsers")}</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {query.isPending && (
          <p className="p-6" role="status">
            {t("common.loading")}
          </p>
        )}
        {!query.isPending && !query.isError && !query.data?.items.length && (
          <p className="p-6">{t(control.search ? "projects.noResults" : "projects.empty")}</p>
        )}
        <DirectoryPagination
          control={control}
          count={query.data?.items.length ?? 0}
          nextCursor={query.data?.nextCursor}
          busy={query.isFetching}
        />
      </section>
      <p className="mt-3 text-xs">{t("projects.ssoOnlyHint")}</p>
      {runnerProject && <ProjectRunnerConfiguration project={runnerProject} returnFocusRef={runnerTrigger} onClose={() => setRunnerProject(null)} />}
      {selected && (
        <ProjectMembers project={selected} returnFocusRef={membersTrigger} onClose={() => setSelected(null)} />
      )}
      {createOpen && (
        <CreateProjectSheet
          returnFocusRef={trigger}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await client.invalidateQueries({ queryKey: ["projects"] });
          }}
        />
      )}
    </section>
  );
}
function ProjectMembers({
  project,
  onClose,
  returnFocusRef,
}: {
  project: Project;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const control = useDirectoryPage(`members:${project.id}`);
  const [candidate, setCandidate] = useState<DirectorySelection[]>([]);
  const query = useQuery({
    queryKey: ["project-members", project.id, control.query],
    queryFn: ({ signal }) =>
      listProjectMembers(project.id, control.query, signal),
  });
  const change = useMutation({
    mutationFn: ({ userId, enabled }: { userId: string; enabled: boolean }) =>
      setProjectMember(project.id, userId, enabled),
    onSuccess: async (_result, variables) => {
      setCandidate([]);
      toast.success(t(variables.enabled ? "accountForm.memberAdded" : "accountForm.memberRemoved"));
      await Promise.all([
        client.invalidateQueries({ queryKey: ["project-members", project.id] }),
        client.invalidateQueries({ queryKey: ["projects"] }),
        client.invalidateQueries({ queryKey: queryKeys.users }),
        client.invalidateQueries({ queryKey: ["user-detail"] }),
        client.invalidateQueries({
          queryKey: ["directory-select", `members:${project.id}`],
        }),
      ]);
    },
  });
  return (
    <EntitySheet
      footer={null}
      returnFocusRef={returnFocusRef}
      open
      onOpenChange={(open) => {
        if (!open && !change.isPending) onClose();
      }}
      closeDisabled={change.isPending}
      title={project.name}
      description={t("projects.ssoOnlyHint")}
      eyebrow={t("projects.manageLocalUsers")}
      width="md"
    >
      {query.error || change.error ? (
        <ErrorNotice error={query.error ?? change.error} />
      ) : null}
      <section className="grid gap-3" aria-label={t("projects.addMember")}>
        <h3 className="text-sm font-medium">{t("projects.addMember")}</h3>
        <DirectorySelect scope={`members:${project.id}`} label={t("accountForm.chooseUser")} value={candidate}
          onChange={setCandidate} single disabled={change.isPending}
          load={async (q, signal) => {
            const page = await listMemberCandidates(project.id, q, signal);
            return { ...page, items: page.items.map(item => ({ id: item.id, name: item.username })) };
          }} />
        <Button className="justify-self-start" disabled={!candidate.length || change.isPending}
          onClick={() => change.mutate({ userId: candidate[0]!.id, enabled: true })}>
          {change.isPending ? t("common.saving") : t("projects.addMember")}
        </Button>
      </section>
      <h3 className="mt-8 mb-3 text-sm font-medium">{t("accountForm.assignedUsers")}</h3>
      {(Boolean(query.data?.items.length) || control.search) && <Input
        aria-label={t("users.search")} placeholder={t("users.search")} value={control.search}
        onChange={event => control.setSearch(event.target.value)} />}
      {!query.isPending && !query.error && !query.data?.items.length && <p className="text-sm text-muted-foreground">{t(control.search ? "users.noResults" : "accountForm.noMembers")}</p>}
      {query.isPending && <p role="status">{t("common.loading")}</p>}
      <ul className="divide-y">
        {query.data?.items.map((member) => (
          <li
            key={member.userId}
            className="flex items-center justify-between gap-3 py-4"
          >
            <div>
              {member.username ?? member.userId}
            </div>
            {member.source === "local" ? (
              <Button
                variant="ghost"
                disabled={change.isPending}
                onClick={() =>
                  change.mutate({ userId: member.userId, enabled: false })
                }
              >
                {t("projects.removeMember")}
              </Button>
            ) : (
              <span className="text-xs">Keycloak</span>
            )}
          </li>
        ))}
      </ul>
      {(control.page.page > 1 || query.data?.nextCursor) && (<DirectoryPagination
        control={control}
        count={query.data?.items.length ?? 0}
        nextCursor={query.data?.nextCursor}
        busy={query.isFetching}
      />)}
    </EntitySheet>
  );
}
function CreateProjectSheet({
  onClose,
  onCreated,
  returnFocusRef,
}: {
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [department, setDepartment] = useState("");
  const create = useMutation({
    mutationFn: () =>
      createProject({
        name: normalizeProjectName(name),
        ...(department.trim()
          ? { externalDepartmentId: department.trim() }
          : {}),
      }),
    onSuccess: (project) => onCreated(project.id),
  });
  return (
    <EntitySheet
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose();
      }}
      closeDisabled={create.isPending}
      returnFocusRef={returnFocusRef}
      eyebrow={t("nav.peopleProjects")}
      title={t("projects.create")}
      description={t("projects.createHint")}
      width="md"
      bodyClassName="people-projects-form"
      footer={
        <>
          <Button
            variant="outline"
            disabled={create.isPending}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            className="people-projects-submit"
            type="submit"
            form="create-project"
            disabled={
              !projectNameSchema.safeParse(name).success || create.isPending
            }
          >
            {create.isPending ? t("common.creating") : t("projects.create")}
          </Button>
        </>
      }
    >
      <form
        id="create-project"
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (projectNameSchema.safeParse(name).success) create.mutate();
        }}
      >
        {create.error && <ErrorNotice error={create.error} />}
        <label className="grid gap-2 text-sm font-medium">
          {t("projects.newName")}
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={45}
            required
            aria-describedby="project-name-hint"
            aria-invalid={Boolean(name && !projectNameSchema.safeParse(name).success)}
          />
        </label>
        <p
          id="project-name-hint"
          className="text-xs leading-5 text-muted-foreground"
        >
          {t("projects.nameHint")}
        </p>
        {name && (projectNameSchema.safeParse(name).success ? <div className="project-create-fact">
          <span>{t("accountForm.projectUrl")}</span>
          <p>{window.location.origin}/{normalizeProjectName(name)}</p>
        </div> : <p role="alert" className="text-xs text-destructive">{t("projects.invalidName")}</p>)}
        <div className="project-create-fact">
          <span>{t("accountForm.defaultRunner")}</span><p>runner-default</p>
          <p className="text-xs text-muted-foreground">{t("accountForm.defaultRunnerHint")}</p>
        </div>
        <label className="grid gap-2 text-sm font-medium">
          {t("projects.newDepartment")}
          <Input
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
            maxLength={128}
            pattern="[a-zA-Z0-9_-]+"
          />
        </label>
        <p className="text-xs leading-5 text-muted-foreground">
          {t("projects.ssoMappingHint")}
        </p>
      </form>
    </EntitySheet>
  );
}
