export type EventTimestamp = {
  date: string;
  time: string;
};
const formatters = new Map<string, { clock: Intl.DateTimeFormat; date: Intl.DateTimeFormat }>();

export function formatEventTimestamp(value: string, locale: string): EventTimestamp {
  const timestamp = new Date(value);
  let formats = formatters.get(locale);
  if (!formats) {
    if (formatters.size >= 8) formatters.clear();
    formats = { clock: new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    }), date: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }) };
    formatters.set(locale, formats);
  }
  const clock = formats.clock.format(timestamp);
  const milliseconds = String(timestamp.getMilliseconds()).padStart(3, "0");
  return {
    date: formats.date.format(timestamp),
    time: `${clock}.${milliseconds}`,
  };
}
