import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { useRoutingText } from "@/components/traffic-routing/form";
import type { PathTestRecord } from "./use-path-workbench";

export function PathTestHistory({
  open,
  onOpenChange,
  records,
  onRestore,
  onClear,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  records: PathTestRecord[];
  onRestore: (record: PathTestRecord) => void;
  onClear: () => void;
}) {
  const t = useRoutingText();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t("测试历史", "Test history")}</SheetTitle>
          <SheetDescription>
            {t(
              "保留本次页面会话最近 50 次测试；恢复请求不会自动发送。",
              "Last 50 tests in this page session. Restoring a request does not send it.",
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-4">
          {records.length ? (
            records.map((item) => (
              <div key={item.id} className="space-y-2 border-b py-4">
                <p className="break-words text-sm font-medium">
                  {item.label} · {item.configuration}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(item.createdAt).toLocaleTimeString()} ·{" "}
                  {item.error
                    ? t("失败", "Failed")
                    : `HTTP ${item.result?.status}`}
                </p>
                <p className="break-all font-mono text-xs">
                  {item.input.request.split("\n")[0]}
                </p>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    onRestore(item);
                    onOpenChange(false);
                  }}
                >
                  {t("恢复请求与结果", "Restore request and result")}
                </Button>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("还没有测试记录。", "No test history yet.")}
            </p>
          )}
        </div>
        <div className="border-t p-4">
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={!records.length}
            onClick={onClear}
          >
            {t("清空历史", "Clear history")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
