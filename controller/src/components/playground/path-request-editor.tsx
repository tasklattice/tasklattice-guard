import { useTranslation } from "react-i18next";
import { Checkbox as CarbonCheckbox } from "@/components/ui/checkbox";
import { NativeSelect as CarbonNativeSelect } from "@/components/ui/native-select";
import { useState } from "react";
import { Braces, Code2, FileCode2, GitBranch, KeyRound, List, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
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

import { newHeader } from "./path-request-model";
import type { PathWorkbench } from "./use-path-workbench";

export function PathRequestEditor({
  workbench: w,
}: {
  workbench: PathWorkbench;
}) {
  const { t: uiText } = useTranslation();
  const { t } = useTranslation();
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
        className="path-request-editor h-full min-h-0 gap-0"
      >
        <div className="path-editor-toolbar">
          <TabsList
            className="border-0"
            aria-label={t("routing.requestEditor")}
          >
            <TabsTrigger value="headers">
              <List aria-hidden="true" className="size-4" />{uiText("uiCopy.headers")}{" "}
              <span className="text-muted-foreground">
                {w.draft.headers.filter((h) => h.enabled && h.name).length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="body"><Braces aria-hidden="true" className="size-4" />{uiText("uiCopy.body")}</TabsTrigger>
            {w.target === "router" ? (
              <TabsTrigger value="context"><GitBranch aria-hidden="true" className="size-4" />
                {t("routing.context")}
              </TabsTrigger>
            ) : (
              <TabsTrigger value="auth"><KeyRound aria-hidden="true" className="size-4" />{t("routing.auth")}</TabsTrigger>
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
              {t("routing.importHTTPCURL")}
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
              <FileCode2 aria-hidden="true" className="size-4" />{t("routing.loadExample")}
            </Button>
          </div>
        </div>
        <TabsContent
          value="headers"
          className="min-h-0 overflow-auto p-3 sm:p-4"
        >
          <div
            role="table"
            aria-label={uiText("uiCopy.hTTPHeaders")}
            className="w-full text-sm"
          >
            <div
              role="row"
              className="grid grid-cols-[2.75rem_minmax(0,1fr)_minmax(0,1.5fr)_2.75rem] items-center gap-1 border-b pb-2 text-xs text-muted-foreground sm:gap-3"
            >
              <span role="columnheader" className="sr-only">
                {t("routing.enabled")}
              </span>
              <span className="col-start-2" role="columnheader">{uiText("uiCopy.header")}</span>
              <span role="columnheader">{uiText("uiCopy.value")}</span>
              <span role="columnheader" className="sr-only">
                {t("routing.remove")}
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
                  <CarbonCheckbox
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
                    placeholder={uiText("uiCopy.header")}
                    className="field:h-11 min-w-0 field:border-transparent field:bg-transparent field:font-mono field:text-xs field:shadow-none"
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
                    placeholder={uiText("uiCopy.value")}
                    className="field:h-11 min-w-0 field:border-transparent field:bg-transparent field:font-mono field:text-xs field:shadow-none"
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
            {t("routing.addHeader")}
          </Button>
        </TabsContent>
        <TabsContent
          value="body"
          className="flex min-h-0 flex-col gap-2 p-3 data-[state=inactive]:hidden sm:p-4"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <CarbonNativeSelect
              aria-label={uiText("uiCopy.bodyFormat")}
              className="path-body-format"
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
              <option value="text">{t("routing.rawText")}</option>
              <option value="json">JSON</option>
            </CarbonNativeSelect>
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
                    t("routing.bodyIsNotValidJSON"),
                  );
                }
              }}
            >
              <Code2 aria-hidden="true" className="size-4" />{t("routing.formatJSON")}
            </Button>
          </div>
          <Textarea
            aria-label={uiText("uiCopy.requestBody")}
            spellCheck={false}
            value={w.draft.body}
            disabled={w.pending}
            onChange={(e) => {
              w.setDraft({ ...w.draft, body: e.target.value });
              setFormatError("");
            }}
            className="field:min-h-20 flex-1 field:resize-none field:font-mono field:text-xs field:leading-6"
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
          <label className="block text-xs">{uiText("uiCopy.callID")}<div className="mt-1 flex gap-2">
              <Input
                className="field:h-11 min-w-0"
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
                <RefreshCw aria-hidden="true" className="size-4" />{t("routing.new")}
              </Button>
            </div>
          </label>
          <p className="text-xs text-muted-foreground">
            {t("routing.theSameCallIDReusesItsPinnedRouteAssignment")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-xs">
              {t("routing.businessFieldsJSON")}
              <Textarea
                className="mt-2 field:min-h-24 field:font-mono field:text-xs"
                value={w.fields}
                disabled={w.pending}
                onChange={(e) => w.setFields(e.target.value)}
              />
            </label>
            <label className="text-xs">
              {t("routing.endpointRequestContextJSON")}
              <Textarea
                className="mt-2 field:min-h-24 field:font-mono field:text-xs"
                value={w.endpointContext}
                disabled={w.pending}
                onChange={(e) => w.setEndpointContext(e.target.value)}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("routing.headersAndTheURLDescribeTheBusinessRequestAdd")}
          </p>
        </TabsContent>
        <TabsContent
          value="auth"
          className="min-h-0 space-y-4 overflow-auto p-4"
        >
          <label className="block max-w-lg space-y-2 text-sm">
            <span>{uiText("uiCopy.endpointAPIKey")}</span>
            <Input
              aria-label={uiText("uiCopy.endpointAPIKey")}
              className="field:h-11"
              type="password"
              autoComplete="off"
              placeholder="X-Api-Key"
              value={w.credential}
              disabled={w.pending}
              onChange={(e) => w.setCredential(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {t("routing.sentAsXApiKeyToTheSelectedEndpoint")}
          </p>
        </TabsContent>
      </Tabs>
      <Sheet open={importOpen} onOpenChange={setImportOpen}>
        <SheetContent className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{t("routing.importRequest")}</SheetTitle>
            <SheetDescription>
              {t("routing.pasteHTTPTextOrCurlToReplaceTheCurrent")}
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pb-4">
            <Textarea
              aria-label={uiText("uiCopy.hTTPRequestOrCurl")}
              className="field:min-h-40 flex-1 field:font-mono field:text-xs"
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
              {t("routing.importAndReplace")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
