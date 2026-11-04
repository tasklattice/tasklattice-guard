import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, RefreshCw, ServerCog } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/product-shell";
import { useAuth } from "@/lib/auth";
import { getProjectAccess, refreshProjectAccess } from "@/lib/projects-api";
import { initializationEmail } from "@/projects-i18n";

export function ProjectInitializationGate({children}: {children: ReactNode}) {
  const {user} = useAuth();
  const {t, i18n} = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [checked, setChecked] = useState(false);
  const query = useQuery({queryKey: ["project-access", user?.id, user?.project_id], queryFn: getProjectAccess, retry: false});
  const refresh = useMutation({mutationFn: refreshProjectAccess, onSuccess: async status => {
    if (status.state === "ready" || status.projectId !== user?.project_id) { window.location.assign("/dashboard"); return; }
    setChecked(true); await query.refetch();
  }});
  if (query.isPending) return <p role="status" className="py-12 text-sm text-muted-foreground">{t("projects.checking")}</p>;
  if (query.isError) return <section className="max-w-3xl space-y-4 py-10"><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()}>{t("common.retry")}</Button></section>;
  if (query.data.state === "ready") return children;
  const email = initializationEmail({chinese: i18n.language.startsWith("zh"), name: user?.display_name ?? "", account: user?.email && !user.email.endsWith("@users.guard.invalid") ? user.email : user?.username ?? "", userId: user?.id ?? "", origin: window.location.origin, status: query.data});
  const template = `${t("projects.emailSubject")}: ${email.subject}\n\n${email.body}`;
  async function copy() {
    try { await navigator.clipboard.writeText(template); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  }
  return <section className="mx-auto max-w-3xl py-12">
    <div className="flex items-start gap-4">
      <ServerCog className="mt-1 size-7 shrink-0 text-muted-foreground" aria-hidden />
      <div><h1 className="text-2xl font-medium">{t(query.data.state === "runner_uninitialized" ? "projects.runnerNotInitialized" : "projects.notInitialized")}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("projects.contactAdmin")}</p></div>
    </div>
    <div className="mt-8 flex gap-3">
      <Button onClick={() => void copy()}><Copy />{t(copied ? "projects.copied" : "projects.copyEmail")}</Button>
      <Button variant="outline" disabled={refresh.isPending} onClick={() => { setChecked(false); refresh.mutate(); }}><RefreshCw className={refresh.isPending ? "animate-spin" : undefined} />{t(refresh.isPending ? "projects.checking" : "projects.checkAgain")}</Button>
    </div>
    <div aria-live="polite" className="mt-3 text-sm text-muted-foreground">{copyError ? t("projects.copyFailed") : copied ? t("projects.copySuccess") : null}{checked ? <p className="mt-2">{t("projects.stillWaiting")}</p> : null}</div>
    {refresh.error ? <div className="mt-4"><ErrorNotice error={refresh.error} /></div> : null}
    <details className="mt-8 border-t pt-5"><summary className="cursor-pointer text-sm font-medium">{t("projects.previewEmail")}</summary>
      <label className="mt-4 grid gap-2 text-sm">{t("projects.emailTemplate")}<textarea readOnly value={template} rows={17} className="w-full resize-y rounded-md border bg-card p-4 text-sm leading-6" /></label>
      <p className="mt-2 text-xs text-muted-foreground">{t("projects.emailHint")}</p>
    </details>
  </section>;
}
