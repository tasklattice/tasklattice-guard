import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DatePicker, DatePickerInput, Popover, PopoverContent, TimePicker } from "@carbon/react";
import { CalendarRange, ChevronDown, Filter } from "lucide-react";
import { metricWindowMilliseconds, type MetricWindow } from "@/lib/api";
import { Button } from "./ui/button";
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
  if ([draft.start, draft.end].some(value => !value.split("T")[0] || !value.split("T")[1])) return { error: "logs.timeRangeRequired" } as const;
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
    window, preset, draft, choosePreset, edit, bounds: { since, until },
    error: parsed.error,
    apply: () => { if (parsed.bounds) onApply(parsed.bounds); },
    reset: () => {
      setDraft(timeDraft(window, { since, until }));
      setPreset(since || until ? "custom" : window);
    },
    fixed: Boolean(until),
  };
}

function rangeExpression(draft: TimeDraft) {
  const [startDate, startTime] = draft.start.split("T");
  const [endDate, endTime] = draft.end.split("T");
  const sameYear = startDate.slice(0, 4) === endDate.slice(0, 4) && startDate.slice(0, 4) === String(new Date().getFullYear());
  const dateLabel = (date: string) => sameYear ? date.slice(5).replace("-", "/") : date;
  return `${dateLabel(startDate)} ${startTime} – ${startDate === endDate ? "" : `${dateLabel(endDate)} `}${endTime}`;
}

export function LogTimeRangeControl({ range, disabled }: { range: ReturnType<typeof useLogTimeRange>; disabled?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const fixed = Boolean(range.bounds.since || range.bounds.until);
  const selected = timeDraft(range.window, range.bounds);
  const label = disabled ? t("logs.allTime") : fixed ? rangeExpression(selected) : t(`dashboard.windows.${range.window}`);
  const close = () => { setOpen(false); range.reset(); };
  // Calendar day selection can blur its input without moving focus outside.
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, range]);
  return <div ref={container} className="log-time-range-filter"
    onBlur={event => { if (open && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) close(); }}
    onKeyDown={event => { if (open && event.key === "Escape") { event.preventDefault(); close(); trigger.current?.focus(); } }}>
    <span className="log-time-range-label"><Filter aria-hidden="true" />{t("logs.windowFilter")}</span>
    <Popover className="log-time-range-popover" open={open && !disabled} align="bottom-start">
      <Button ref={trigger} type="button" variant="ghost" className="log-time-range-trigger" disabled={disabled}
        aria-label={t("logs.windowFilter")} aria-haspopup="dialog" aria-expanded={open && !disabled} aria-controls={open ? id : undefined}
        title={fixed ? `${selected.start.replace("T", " ")} – ${selected.end.replace("T", " ")}` : label}
        onClick={() => { if (open) close(); else setOpen(true); }}>
        <CalendarRange aria-hidden="true" /><span>{label}</span><ChevronDown aria-hidden="true" />
      </Button>
      {open && !disabled && <PopoverContent id={id} role="dialog" aria-label={t("logs.preciseTimeRange")}>
        <div className="log-time-range-presets" aria-label={t("logs.windowFilter")}>
          {(["1h", "24h", "7d", "15d", "30d"] as MetricWindow[]).map(value => <Button key={value} type="button" size="sm"
            variant="ghost" aria-pressed={range.preset === value}
            onClick={() => { range.choosePreset(value); setOpen(false); }}>{t(`dashboard.windows.${value}`)}</Button>)}
        </div>
        <LogTimeRangeFields range={range} onCancel={close} onApply={() => setOpen(false)} />
      </PopoverContent>}
    </Popover>
  </div>;
}

function LogTimeRangeFields({ range, onCancel, onApply }: { range: ReturnType<typeof useLogTimeRange>; onCancel: () => void; onApply: () => void }) {
  const { t, i18n } = useTranslation();
  const prefix = useId();
  const [calendarContainer, setCalendarContainer] = useState<HTMLFormElement | null>(null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <form ref={setCalendarContainer} className="log-time-range" onSubmit={event => { event.preventDefault(); if (!range.error) { range.apply(); onApply(); } }}>
    <div className="log-time-range-fields">
      {calendarContainer && (["start", "end"] as const).map(field => {
        const [date = "", time = ""] = range.draft[field].split("T");
        const editDate = (value: string) => range.edit(field, `${value}T${time}`);
        const editTime = (value: string) => range.edit(field, `${date}T${value}`);
        return <div className="log-time-range-bound" key={field}>
          <DatePicker appendTo={calendarContainer} datePickerType="single" dateFormat="Y-m-d" locale={i18n.language.startsWith("zh") ? "zh" : "en"}
            value={date} onChange={dates => editDate(dates[0] ? localMinute(dates[0]).split("T")[0] : "")}>
            <DatePickerInput id={`${prefix}-${field}-date`} labelText={t(field === "start" ? "logs.startDate" : "logs.endDate")}
              placeholder="YYYY-MM-DD" pattern={"\\d{4}-\\d{2}-\\d{2}"} size="lg" aria-describedby={`${prefix}-hint`}
              onChange={event => editDate(event.target.value)} />
          </DatePicker>
          <TimePicker id={`${prefix}-${field}-time`} labelText={t(field === "start" ? "logs.startTime" : "logs.endTime")}
            placeholder="HH:mm" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" size="lg" value={time}
            aria-describedby={`${prefix}-hint`} aria-invalid={Boolean(range.error)}
            onInput={event => editTime(event.currentTarget.value)} onChange={event => editTime(event.target.value)} />
        </div>;
      })}
    </div>
    <p id={`${prefix}-hint`} className="log-time-range-hint" role={range.error ? "alert" : undefined}>
      {range.error ? t(range.error) : t(range.preset === "custom" ? "logs.preciseTimeHint" : "logs.presetTimeHint", { timezone })}
    </p>
    <div className="log-time-range-actions"><Button type="button" variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
      <Button type="submit" disabled={Boolean(range.error)}>{t("logs.applyTimeRange")}</Button></div>
  </form>;
}
