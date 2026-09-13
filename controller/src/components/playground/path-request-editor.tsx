import { useState } from "react";
import { Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useRoutingText } from "@/components/traffic-routing/form";
import { newHeader } from "./path-request-model";
import type { PathWorkbench } from "./use-path-workbench";

export function PathRequestEditor({
  workbench: w,
}: {
  workbench: PathWorkbench;
}) {
  const t = useRoutingText();
  const [tab, setTab] = useState("headers");
  const [importOpen, setImportOpen] = useState(false);
  const [source, setSource] = useState("");
  const [importError, setImportError] = useState("");
  const [formatError, setFormatError] = useState("");
  const updateHeader = (
    id: string,
    patch: Partial<(typeof w.draft.headers)[number]>,
  ) =>
    w.setDraft({
      ...w.draft,
      headers: w.draft.headers.map((h) =>
        h.id === id ? { ...h, ...patch } : h,
      ),
    });
  const activeTab =
    (tab === "auth" && w.target === "router") ||
    (tab === "context" && w.target === "endpoint")
      ? "headers"
      : tab;
  const jsonBody = w.draft.headers.some(
    (h) =>
      h.enabled &&
      h.name.toLowerCase() === "content-type" &&
      h.value.includes("json"),
  );
  let syntaxError = "";
  if (jsonBody && w.draft.body.trim()) {
    try {
      JSON.parse(w.draft.body);
    } catch (e) {
      syntaxError = e instanceof Error ? e.message : String(e);
    }
  }
  return (
    <>
      <Tabs
        value={activeTab}
        onValueChange={setTab}
        className="h-full min-h-0 gap-0"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between border-b px-3 sm:px-4">
          <TabsList
            className="border-0"
            aria-label={t("请求编辑", "Request editor")}
          >
            <TabsTrigger value="headers">
              Headers{" "}
              <span className="text-muted-foreground">
                {w.draft.headers.filter((h) => h.enabled && h.name).length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="body">Body</TabsTrigger>
            {w.target === "router" ? (
              <TabsTrigger value="context">
                {t("路由上下文", "Context")}
              </TabsTrigger>
            ) : (
              <TabsTrigger value="auth">{t("认证", "Auth")}</TabsTrigger>
            )}
          </TabsList>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={w.pending}
              onClick={() => {
                setSource("");
                setImportError("");
                setImportOpen(true);
              }}
            >
              <Upload className="size-4" />
              {t("导入 HTTP/cURL", "Import HTTP/cURL")}
            </Button>
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={w.pending || Boolean(w.unavailable)}
              onClick={() => {
                w.loadExample();
                setFormatError("");
              }}
            >
              {t("填入示例", "Load example")}
            </Button>
          </div>
        </div>
        <TabsContent
          value="headers"
          className="min-h-0 overflow-auto p-3 sm:p-4"
        >
          <div
            role="table"
            aria-label="HTTP headers"
            className="w-full text-sm"
          >
            <div
              role="row"
              className="grid grid-cols-[2.75rem_minmax(0,1fr)_minmax(0,1.5fr)_2.75rem] items-center gap-1 border-b pb-2 text-xs text-muted-foreground sm:gap-3"
            >
              <span role="columnheader" className="sr-only">
                {t("启用", "Enabled")}
              </span>
              <span className="col-start-2" role="columnheader">
                Header
              </span>
              <span role="columnheader">Value</span>
              <span role="columnheader" className="sr-only">
                {t("删除", "Remove")}
              </span>
            </div>
            {w.draft.headers.map((h, index) => (
              <div
                role="row"
                key={h.id}
                className="grid grid-cols-[2.75rem_minmax(0,1fr)_minmax(0,1.5fr)_2.75rem] items-center gap-1 border-b py-1 sm:gap-3"
              >
                <label
                  role="cell"
                  className="flex size-11 cursor-pointer items-center justify-center"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    aria-label={`Enable header ${index + 1}`}
                    checked={h.enabled}
                    disabled={w.pending}
                    onChange={(e) =>
                      updateHeader(h.id, { enabled: e.target.checked })
                    }
                  />
                </label>
                <div role="cell">
                  <Input
                    aria-label={`Header ${index + 1} name`}
                    placeholder="Header"
                    className="h-11 min-w-0 border-transparent bg-transparent font-mono text-xs shadow-none"
                    value={h.name}
                    disabled={w.pending}
                    onChange={(e) =>
                      updateHeader(h.id, { name: e.target.value })
                    }
                  />
                </div>
                <div role="cell">
                  <Input
                    aria-label={`Header ${index + 1} value`}
                    placeholder="Value"
                    className="h-11 min-w-0 border-transparent bg-transparent font-mono text-xs shadow-none"
                    value={h.value}
                    disabled={w.pending}
                    onChange={(e) =>
                      updateHeader(h.id, { value: e.target.value })
                    }
                  />
                </div>
                <div role="cell">
                  <Button
                    variant="ghost"
                    className="size-11"
                    aria-label={`Remove header ${index + 1}`}
                    disabled={w.pending}
                    onClick={() =>
                      w.setDraft({
                        ...w.draft,
                        headers: w.draft.headers.filter(
                          (row) => row.id !== h.id,
                        ),
                      })
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <Button
            variant="ghost"
            className="mt-2 min-h-11"
            disabled={w.pending}
            onClick={() =>
              w.setDraft({
                ...w.draft,
                headers: [...w.draft.headers, newHeader()],
              })
            }
          >
            <Plus className="size-4" />
            {t("添加 Header", "Add header")}
          </Button>
        </TabsContent>
        <TabsContent
          value="body"
          className="flex min-h-0 flex-col gap-2 p-3 data-[state=inactive]:hidden sm:p-4"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <select
              aria-label="Body format"
              className="h-11 rounded-md border bg-background px-3 text-sm text-foreground"
              value={jsonBody ? "json" : "text"}
              disabled={w.pending}
              onChange={(e) => {
                const contentType =
                  e.target.value === "json" ? "application/json" : "text/plain";
                w.setDraft({
                  ...w.draft,
                  headers: [
                    ...w.draft.headers.filter(
                      (h) => h.name.toLowerCase() !== "content-type",
                    ),
                    newHeader("Content-Type", contentType),
                  ],
                });
              }}
            >
              <option value="text">{t("原始文本", "Raw text")}</option>
              <option value="json">JSON</option>
            </select>
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={w.pending}
              onClick={() => {
                try {
                  w.setDraft({
                    ...w.draft,
                    body: JSON.stringify(JSON.parse(w.draft.body), null, 2),
                  });
                  setFormatError("");
                } catch {
                  setFormatError(
                    t("Body 不是有效的 JSON。", "Body is not valid JSON."),
                  );
                }
              }}
            >
              {t("格式化 JSON", "Format JSON")}
            </Button>
          </div>
          <Textarea
            aria-label="Request body"
            spellCheck={false}
            value={w.draft.body}
            disabled={w.pending}
            onChange={(e) => {
              w.setDraft({ ...w.draft, body: e.target.value });
              setFormatError("");
            }}
            className="min-h-20 flex-1 resize-none font-mono text-xs leading-6"
          />
          {(syntaxError || formatError) && (
            <p role="status" className="text-xs text-destructive">
              {formatError || syntaxError}
            </p>
          )}
        </TabsContent>
        <TabsContent
          value="context"
          className="min-h-0 space-y-4 overflow-auto p-4"
        >
          <label className="block text-xs">
            Call ID
            <div className="mt-1 flex gap-2">
              <Input
                className="h-11 min-w-0"
                value={w.callId}
                disabled={w.pending}
                onChange={(e) => w.setCallId(e.target.value)}
              />
              <Button
                className="min-h-11"
                variant="outline"
                disabled={w.pending}
                onClick={() => w.setCallId(`test-${crypto.randomUUID()}`)}
              >
                {t("重新生成", "New")}
              </Button>
            </div>
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              "相同 Call ID 会沿用固定的路由分配。",
              "The same Call ID reuses its pinned route assignment.",
            )}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs">
              {t("业务字段 JSON", "Business fields JSON")}
              <Textarea
                className="mt-2 min-h-24 font-mono text-xs"
                value={w.fields}
                disabled={w.pending}
                onChange={(e) => w.setFields(e.target.value)}
              />
            </label>
            <label className="text-xs">
              {t("Endpoint 请求上下文 JSON", "Endpoint request context JSON")}
              <Textarea
                className="mt-2 min-h-24 font-mono text-xs"
                value={w.endpointContext}
                disabled={w.pending}
                onChange={(e) => w.setEndpointContext(e.target.value)}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              "Headers 与地址栏描述原始业务请求；此处补充其他匹配字段。",
              "Headers and the URL describe the business request; add other matching fields here.",
            )}
          </p>
        </TabsContent>
        <TabsContent
          value="auth"
          className="min-h-0 space-y-4 overflow-auto p-4"
        >
          <label className="block max-w-lg space-y-2 text-sm">
            <span>Endpoint API key</span>
            <Input
              aria-label="Endpoint API key"
              className="h-11"
              type="password"
              autoComplete="off"
              placeholder="X-Api-Key"
              value={w.credential}
              disabled={w.pending}
              onChange={(e) => w.setCredential(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {t(
              "通过 X-Api-Key 发送到所选 Endpoint。凭证不会写入测试历史。",
              "Sent as X-Api-Key to the selected Endpoint. Credentials are excluded from test history.",
            )}
          </p>
        </TabsContent>
      </Tabs>
      <Sheet open={importOpen} onOpenChange={setImportOpen}>
        <SheetContent className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{t("导入请求", "Import request")}</SheetTitle>
            <SheetDescription>
              {t(
                "粘贴 HTTP 明文或 cURL，解析后替换当前请求。",
                "Paste HTTP text or curl to replace the current request.",
              )}
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4">
            <Textarea
              aria-label="HTTP request or curl"
              className="min-h-40 flex-1 font-mono text-xs"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              maxLength={65536}
            />
            {importError && (
              <p role="alert" className="text-sm text-destructive">
                {importError}
              </p>
            )}
            <Button
              className="min-h-11"
              disabled={!source.trim()}
              onClick={() => {
                try {
                  w.importSource(source);
                  setTab("headers");
                  setImportOpen(false);
                } catch (e) {
                  setImportError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              {t("导入并替换", "Import and replace")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
