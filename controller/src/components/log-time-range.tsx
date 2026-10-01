import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarRange } from "lucide-react";
import { metricWindowMilliseconds, type MetricWindow } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import "./log-time-range.scss";

type TimeBounds = { since?: string; until?: string };
type TimeDraft = { start: string; end: string };
export type LogTimePreset = MetricWindow | "custom";

function localMinute(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function timeDraft(window: MetricWindow, bounds: TimeBounds = {}): TimeDraft {
  const now = Date.now();
  const start = bounds.since ? new Date(bounds.since) : new Date(now - metricWindowMilliseconds(window));
  const end = bounds.until ? new Date(bounds.until) : new Date(now);
  return { start: Number.isNaN(start.getTime()) ? "" : localMinute(start), end: Number.isNaN(end.getTime()) ? "" : localMinute(end) };
}

function parseDraft(draft: TimeDraft) {
  if (!draft.start || !draft.end) return { error: "logs.timeRangeRequired" } as const;
  const start = new Date(draft.start);
  const end = new Date(draft.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || localMinute(start) !== draft.start || localMinute(end) !== draft.end) {
    return { error: "logs.timeRangeInvalid" } as const;
  }
  if (start > end) return { error: "logs.timeRangeReversed" } as const;
  // Include the entire selected end minute, including subsecond timestamps.
  end.setSeconds(59, 999);
  return { bounds: { since: start.toISOString(), until: end.toISOString() } } as const;
}

export function useLogTimeRange(bounds: TimeBounds, onApply: (bounds: TimeBounds) => void) {
  const [window, setWindow] = useState<MetricWindow>("24h");
  const [preset, setPreset] = useState<LogTimePreset>(bounds.since || bounds.until ? "custom" : "24h");
  const [draft, setDraft] = useState(() => timeDraft("24h", bounds));
  const { since, until } = bounds;

  // Restore dates for Back/Forward and links from Router monitoring.
  useEffect(() => {
    setDraft(timeDraft(window, { since, until }));
    setPreset(since || until ? "custom" : window);
  }, [since, until, window]);

  useEffect(() => {
    if (preset === "custom") return;
    const timer = setInterval(() => setDraft(timeDraft(window)), 60_000);
    return () => clearInterval(timer);
  }, [preset, window]);

  const choosePreset = (value: LogTimePreset) => {
    setPreset(value);
    if (value === "custom") return;
    setWindow(value);
    setDraft(timeDraft(value));
    onApply({ since: undefined, until: undefined });
  };
  const edit = (field: keyof TimeDraft, value: string) => {
    setPreset("custom");
    setDraft(previous => ({ ...previous, [field]: value }));
  };
  const parsed = parseDraft(draft);
  return {
    window, preset, draft, choosePreset, edit,
    error: parsed.error,
    apply: () => { if (parsed.bounds) onApply(parsed.bounds); },
    fixed: Boolean(until),
  };
}

export function LogTimeRangeFields({ range, disabled }: { range: ReturnType<typeof useLogTimeRange>; disabled?: boolean }) {
  const { t } = useTranslation();
  const prefix = useId();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <form className="log-time-range" aria-label={t("logs.preciseTimeRange")} onSubmit={event => { event.preventDefault(); if (!disabled) range.apply(); }}>
    <div className="log-time-range-fields">
      <label htmlFor={`${prefix}-start`}>
        <span><CalendarRange aria-hidden="true" />{t("logs.startTime")}</span>
        <Input id={`${prefix}-start`} type="datetime-local" step={60} value={range.draft.start} disabled={disabled}
          aria-describedby={`${prefix}-hint`} aria-invalid={Boolean(range.error)} onInput={event => range.edit("start", event.currentTarget.value)} onChange={event => range.edit("start", event.target.value)} />
      </label>
      <label htmlFor={`${prefix}-end`}>
        <span><CalendarRange aria-hidden="true" />{t("logs.endTime")}</span>
        <Input id={`${prefix}-end`} type="datetime-local" step={60} value={range.draft.end} disabled={disabled}
          aria-describedby={`${prefix}-hint`} aria-invalid={Boolean(range.error)} onInput={event => range.edit("end", event.currentTarget.value)} onChange={event => range.edit("end", event.target.value)} />
      </label>
      <Button type="submit" disabled={disabled || Boolean(range.error)}>{t("logs.applyTimeRange")}</Button>
    </div>
    <p id={`${prefix}-hint`} className="log-time-range-hint" role={range.error && !disabled ? "alert" : undefined}>
      {range.error && !disabled ? t(range.error) : t(disabled ? "logs.exactEventTimeHint" : range.preset === "custom" ? "logs.preciseTimeHint" : "logs.presetTimeHint", { timezone })}
    </p>
  </form>;
}
