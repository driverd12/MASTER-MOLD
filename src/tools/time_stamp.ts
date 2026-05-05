import { z } from "zod";

export const timeStampSchema = z.object({
  timezone: z.string().min(1).max(100).optional(),
  locale: z.string().min(1).max(80).optional(),
  at: z.string().datetime({ offset: true }).optional(),
});

type TimeStampInput = z.infer<typeof timeStampSchema>;

function defaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function compactUtc(date: Date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}T${iso.slice(11, 19).replace(/:/g, "")}Z`;
}

function filenameUtc(date: Date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, "-")}Z`;
}

function filenameSafe(value: string) {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "local"
  );
}

function dateParts(date: Date, timezone: string, locale: string) {
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    timeZoneName: "shortOffset",
    hourCycle: "h23",
  });
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const year = parts.get("year") ?? "0000";
  const month = parts.get("month") ?? "00";
  const day = parts.get("day") ?? "00";
  const hour = parts.get("hour") ?? "00";
  const minute = parts.get("minute") ?? "00";
  const second = parts.get("second") ?? "00";
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: parts.get("weekday") ?? null,
    offset: parts.get("timeZoneName") ?? null,
  };
}

function humanLocal(date: Date, timezone: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(date);
}

export function timeStamp(input: TimeStampInput) {
  const timezone = input.timezone?.trim() || defaultTimezone();
  const locale = input.locale?.trim() || "en-US";
  const date = input.at ? new Date(input.at) : new Date();
  const parts = dateParts(date, timezone, locale);
  const dateUtc = date.toISOString().slice(0, 10);
  const timeUtc = `${date.toISOString().slice(11, 19)}Z`;
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localTime = `${parts.hour}:${parts.minute}:${parts.second}`;
  const zoneSlug = filenameSafe(timezone);

  return {
    ok: true,
    source: input.at ? "provided_at" : "system_clock",
    timezone,
    locale,
    iso_utc: date.toISOString(),
    date_utc: dateUtc,
    time_utc: timeUtc,
    unix_seconds: Math.floor(date.getTime() / 1000),
    unix_milliseconds: date.getTime(),
    local: {
      timezone,
      date: localDate,
      time: localTime,
      weekday: parts.weekday,
      offset: parts.offset,
      human: humanLocal(date, timezone, locale),
    },
    stamps: {
      iso_utc: date.toISOString(),
      compact_utc: compactUtc(date),
      filename_utc: filenameUtc(date),
      filename_local: `${localDate}_${localTime.replace(/:/g, "-")}_${zoneSlug}`,
      human_local: humanLocal(date, timezone, locale),
    },
  };
}
