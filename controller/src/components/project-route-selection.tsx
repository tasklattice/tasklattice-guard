import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth";
import { selectProject } from "@/lib/projects-api";
import { projectPath } from "@/lib/project-paths";
import { ErrorNotice } from "@/components/product-shell";
import { Button } from "@/components/ui/button";

/** Do not mount resource queries until the URL and server session agree. */
export function ProjectRouteSelection({ projectId }: { projectId: string }) {
  const { user, refreshSession } = useAuth();
  const { t } = useTranslation();
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const request = useRef<{ projectId: string; attempt: number; promise: Promise<void> } | null>(null);
  useEffect(() => {
    // Reuse the request across StrictMode's effect replay, but subscribe again
    // so a rejected selection still reaches the mounted error UI.
    if (request.current?.projectId !== projectId || request.current.attempt !== attempt) {
      request.current = { projectId, attempt, promise: selectProject(projectId).then(refreshSession) };
    }
    let mounted = true;
    void request.current.promise.catch(error => { if (mounted) setFailure({ error }); });
    return () => { mounted = false; };
  }, [projectId, attempt, refreshSession]);

  return <main className="mx-auto max-w-3xl space-y-4 p-10">
    {failure ? <>
      <ErrorNotice error={failure.error} />
      <Button onClick={() => { setFailure(null); setAttempt(value => value + 1); }}>{t("common.retry")}</Button>
      <Button variant="outline" asChild><a href={user?.project_id ? projectPath(user.project_id) : "/account"}>{t(user?.project_id ? "nav.dashboard" : "account.title")}</a></Button>
    </> : <p role="status">{t("projects.switching")}</p>}
  </main>;
}
