import { useSyncExternalStore } from "react";
import { ToastNotification } from "@carbon/react";
import { useTranslation } from "react-i18next";
type Notice = {
  id: number;
  kind: "success" | "error" | "info" | "warning";
  title: string;
};
let notices: Notice[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const emit = () => listeners.forEach((listener) => listener());
function dismiss(id?: number) {
  notices = notices.filter((item) => id !== undefined && item.id !== id);
  for (const [key, timer] of timers) {
    if (id === undefined || key === id) {
      clearTimeout(timer);
      timers.delete(key);
    }
  }
  emit();
}
function show(kind: Notice["kind"], title: string) {
  const id = ++nextId;
  notices = [...notices, { id, kind, title }].slice(-4);
  emit();
  timers.set(
    id,
    setTimeout(() => dismiss(id), 7000),
  );
  return id;
}
export const toast = {
  success: (title: string) => show("success", title),
  error: (title: string) => show("error", title),
  info: (title: string) => show("info", title),
  warning: (title: string) => show("warning", title),
  dismiss,
};
export function Toaster() {
  const { t } = useTranslation();
  const items = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => notices,
  );
  return (
    <section
      className="guard-toast-region"
      aria-label={t("common.notifications", "Notifications")}
    >
      {items.map((item) => (
        <ToastNotification
          key={item.id}
          kind={item.kind}
          title={item.title}
          lowContrast
          caption=""
          role={item.kind === "error" ? "alert" : "status"}
          aria-label={t("common.close")}
          onClose={() => {
            dismiss(item.id);
            return true;
          }}
        />
      ))}
    </section>
  );
}
