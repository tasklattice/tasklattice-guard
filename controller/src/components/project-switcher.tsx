import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverContent } from "@carbon/react";
import { Check, ChevronLeft, ChevronRight, ChevronsUpDown, FolderKanban, LoaderCircle, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDirectoryPage } from "./directory-pagination";
import { useAuth } from "@/lib/auth";
import { listMyProjects, selectProject } from "@/lib/projects-api";
import "./project-switcher.scss";

/** Owns the current Project identity, directory and session switch in one place. */
export function ProjectSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);
  if (user?.role !== "user") return null;
  const name = user.project_id ?? t("projects.select");
  const close = () => { setOpen(false); trigger.current?.focus(); };

  async function change(projectId: string) {
    if (pending) return;
    if (projectId === user?.project_id) { close(); return; }
    setError(false);
    setPending(projectId);
    try {
      await selectProject(projectId);
      // Re-enter with the persisted session; no cached data crosses Projects.
      window.location.assign("/dashboard");
    } catch {
      setError(true);
      setPending(null);
    }
  }

  return <Popover as="div" className="project-switcher" data-collapsed={collapsed}
    open={open} align={collapsed ? "right-start" : "bottom-start"} autoAlign caret={false}
    onRequestClose={() => setOpen(false)} onKeyDown={event => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
    <button ref={trigger} type="button" className="project-switcher__trigger"
      aria-label={t("projects.switchLabel", { project: name })} title={name}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setError(false); setOpen(!open); }}>
      <FolderKanban size={18} strokeWidth={1.75} aria-hidden="true" />
      <span className="project-switcher__name">{name}</span>
      <ChevronsUpDown className="project-switcher__chevron" size={16} aria-hidden="true" />
    </button>
    {open && <PopoverContent className="project-switcher__popup">
      <div id={id} role="dialog" aria-label={t("projects.switchTitle")} className="project-switcher__panel">
        <ProjectDirectory userId={user.id} currentProjectId={user.project_id} pending={pending}
          onSelect={projectId => void change(projectId)} />
        {error && <p role="alert" className="project-switcher__error">{t("projects.switchFailed")}</p>}
      </div>
    </PopoverContent>}
  </Popover>;
}

function ProjectDirectory({ userId, currentProjectId, pending, onSelect }: {
  userId: string; currentProjectId: string | null; pending: string | null; onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const control = useDirectoryPage(`project-switcher:${userId}`);
  const query = useQuery({
    queryKey: ["my-projects", userId, control.query],
    queryFn: ({ signal }) => listMyProjects(control.query, signal),
    retry: false,
  });
  const searching = control.search.trim() !== control.query.q;
  const loading = query.isPending || searching;
  const busy = Boolean(pending) || query.isFetching || searching;

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-project-option]:not(:disabled)")];
    if (!options.length) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % options.length : (index <= 0 ? options.length : index) - 1;
    options[next]?.focus();
  }

  return <div onKeyDown={moveFocus}>
    <p className="project-switcher__heading">{t("projects.switchTitle")}</p>
    <div className="project-switcher__search">
      <Search size={16} aria-hidden="true" />
      <input type="search" autoFocus aria-label={t("projects.search")} placeholder={t("projects.search")}
        value={control.search} maxLength={100} disabled={Boolean(pending)}
        onChange={event => control.setSearch(event.target.value)} />
    </div>
    <div className="project-switcher__list" aria-busy={loading}>
      {loading ? <p role="status" className="project-switcher__message">{t("common.loading")}</p>
        : query.isError ? <div className="project-switcher__message">
          <p role="alert">{t("projects.loadFailed")}</p>
          <button type="button" className="project-switcher__retry" onClick={() => void query.refetch()}>{t("common.retry")}</button>
        </div> : query.data?.items.length ? query.data.items.map(project => <button type="button" key={project.id}
          className="project-switcher__option" data-project-option aria-current={currentProjectId === project.id ? "true" : undefined}
          disabled={Boolean(pending)} onClick={() => onSelect(project.id)} title={project.name}>
          <FolderKanban size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{project.name}</span>
          {pending === project.id ? <LoaderCircle size={16} className="animate-spin" aria-label={t("projects.switching")} />
            : currentProjectId === project.id ? <Check size={16} aria-hidden="true" /> : null}
        </button>) : <p role="status" className="project-switcher__message">{t(control.query.q ? "projects.noResults" : "projects.noAccess")}</p>}
    </div>
    {(control.page.page > 1 || query.data?.nextCursor) && <div className="project-switcher__pagination">
      <span>{t("eventPagination.page", { page: control.page.page })}</span>
      <button type="button" aria-label={t("common.previous")} title={t("common.previous")}
        disabled={busy || control.page.page === 1} onClick={control.page.previous}><ChevronLeft size={16} /></button>
      <button type="button" aria-label={t("common.next")} title={t("common.next")}
        disabled={busy || !query.data?.nextCursor} onClick={() => { if (query.data?.nextCursor) control.page.next(query.data.nextCursor); }}><ChevronRight size={16} /></button>
    </div>}
  </div>;
}
