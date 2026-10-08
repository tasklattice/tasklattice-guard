import { useEffect, useState } from "react";
import { FileCode2, PackageOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { GuardrailVersionDetail } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SyntaxCode } from "./syntax-code";

export function CompiledRuntime({ detail }: { detail: GuardrailVersionDetail }) {
  const { t } = useTranslation();

  return (
    <Card className="gap-0 overflow-hidden py-0 shadow-none">
      <Tabs defaultValue="summary" className="gap-0">
        <header className="border-b px-4 pt-4">
          <div className="flex items-start gap-2">
            <PackageOpen className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <CardTitle>{t("guardrails.compiledRuntime")}</CardTitle>
              <CardDescription className="mt-1">
                {t("guardrails.compiledRuntimeSummary", {
                  rails: detail.rails.length,
                  actions: detail.actions.length,
                  models: detail.models.length,
                  files: detail.artifacts.length,
                })}
              </CardDescription>
            </div>
          </div>
          <TabsList className="mt-2" aria-label={t("guardrails.compiledRuntimeViews")}>
            <TabsTrigger value="summary">{t("guardrails.compiledRuntimeSummaryTab")}</TabsTrigger>
            <TabsTrigger value="files">{t("guardrails.generatedFilesTab", { count: detail.artifacts.length })}</TabsTrigger>
          </TabsList>
        </header>

        <TabsContent value="summary" className="m-0">
          <div className="grid lg:grid-cols-2">
            <RuntimeExecutionSummary detail={detail} />
            <RuntimeDependencySummary detail={detail} />
          </div>
        </TabsContent>

        <TabsContent value="files" className="m-0">
          <GeneratedVersionFiles detail={detail} />
        </TabsContent>
      </Tabs>
    </Card>
  );
}

export function GeneratedVersionFiles({ detail, fillHeight = false }: { detail: GuardrailVersionDetail; fillHeight?: boolean }) {
  const { t } = useTranslation();
  const [selectedPath, setSelectedPath] = useState(detail.artifacts[0]?.path ?? "");
  const selectedArtifact = detail.artifacts.find((artifact) => artifact.path === selectedPath) ?? detail.artifacts[0];

  useEffect(() => {
    if (!detail.artifacts.some((artifact) => artifact.path === selectedPath)) {
      setSelectedPath(detail.artifacts[0]?.path ?? "");
    }
  }, [detail.artifacts, selectedPath]);

  return <div className={cn("overflow-hidden border", fillHeight && "h-full min-h-0")}>
          {selectedArtifact ? (
            <div className={cn("grid min-w-0 grid-cols-[13rem_minmax(0,1fr)]", fillHeight && "h-full min-h-0")}>
              <div className="min-h-0 overflow-y-auto overscroll-contain border-r p-3">
                <nav className="space-y-1" aria-label={t("guardrails.artifactFiles")}>
                  {detail.artifacts.map((artifact) => (
                    <button
                      key={artifact.path}
                      type="button"
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left font-mono text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                        artifact.path === selectedArtifact.path
                          ? "bg-primary/[0.08] text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      aria-current={artifact.path === selectedArtifact.path ? "true" : undefined}
                      aria-label={artifact.path}
                      title={artifact.path}
                      onClick={() => setSelectedPath(artifact.path)}
                    >
                      <FileCode2 className="size-3.5 shrink-0" />
                      <span className="min-w-0 py-2">
                        <span className="block break-words">{artifact.path.split("/").at(-1)}</span>
                        {artifact.path.includes("/") ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{artifact.path.slice(0, artifact.path.lastIndexOf("/"))}</span> : null}
                      </span>
                    </button>
                  ))}
                </nav>
              </div>
              <section className="flex min-h-0 min-w-0 flex-col" aria-label={selectedArtifact.path}>
                <header className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b bg-muted/20 px-4 py-2">
                  <code className="break-all text-xs font-medium">{selectedArtifact.path}</code>
                  <Badge variant="outline" className="shrink-0 uppercase">{selectedArtifact.language}</Badge>
                </header>
                <SyntaxCode key={selectedArtifact.path} content={selectedArtifact.content} language={selectedArtifact.language}
                  label={`${t("guardrails.generatedFile")}: ${selectedArtifact.path}`} className={fillHeight ? "min-h-0 flex-1" : "max-h-[32rem]"} />
              </section>
            </div>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t("guardrails.noGeneratedFiles")}</p>
          )}
  </div>;
}

export function RuntimeExecutionSummary({ detail }: { detail: GuardrailVersionDetail }) {
  const { t } = useTranslation();
  return (
    <section className="min-w-0 border-b p-4 lg:border-r lg:border-b-0" aria-labelledby="compiled-runtime-execution">
      <h3 id="compiled-runtime-execution" className="text-sm font-semibold">{t("guardrails.compiledRailsActions")}</h3>
      {detail.rails.length || detail.actions.length ? (
        <div className="mt-3 divide-y rounded-lg border">
          {detail.rails.map((rail, index) => (
            <div key={`${rail.rail_type}:${rail.flow}:${index}`} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
              <code className="min-w-0 truncate text-xs">{rail.flow}</code>
              <Badge variant="outline" className="shrink-0 uppercase">{rail.rail_type}</Badge>
            </div>
          ))}
          {detail.actions.map((action, index) => (
            <div key={`${action.name}:${action.flow}:${index}`} className="grid min-h-11 gap-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <code className="block truncate text-xs">{action.name}{action.version ? `@${action.version}` : ""}</code>
                {action.phases.length ? <span className="mt-0.5 block text-[11px] uppercase text-muted-foreground">{action.phases.join(" · ")}</span> : null}
              </div>
              <span className="text-xs tabular-nums text-muted-foreground">{action.timeout_ms} ms</span>
            </div>
          ))}
        </div>
      ) : <p className="mt-3 text-xs text-muted-foreground">{t("guardrails.noCompiledRailsActions")}</p>}
    </section>
  );
}

export function RuntimeDependencySummary({ detail }: { detail: GuardrailVersionDetail }) {
  const { t } = useTranslation();
  return (
    <section className="min-w-0 p-4" aria-labelledby="compiled-runtime-dependencies">
      <h3 id="compiled-runtime-dependencies" className="text-sm font-semibold">{t("guardrails.dependenciesModels")}</h3>
      {detail.models.length || detail.dependencies.length ? (
        <div className="mt-3 space-y-4">
          {detail.models.length ? <RuntimeReferenceList label={t("guardrails.models")} items={detail.models.map((model) => `model:${model}`)} /> : null}
          {detail.dependencies.length ? <RuntimeReferenceList label={t("guardrails.dependencies")} items={detail.dependencies.map((item) => `${item.kind}:${item.name}@${item.version}`)} /> : null}
        </div>
      ) : <p className="mt-3 text-xs text-muted-foreground">{t("guardrails.noExternalDependencies")}</p>}
    </section>
  );
}

function RuntimeReferenceList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
      <div className="mt-1.5 divide-y rounded-lg border">
        {items.map((item) => <code key={item} className="block min-w-0 truncate px-3 py-2.5 text-xs" title={item}>{item}</code>)}
      </div>
    </div>
  );
}
