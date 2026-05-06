import os from "node:os";
import { z } from "zod";

export const timeStampSchema = z.object({
  timezone: z.string().min(1).max(100).optional(),
  locale: z.string().min(1).max(80).optional(),
  at: z.string().datetime({ offset: true }).optional(),
  source_client: z.string().min(1).max(120).optional(),
  source_agent: z.string().min(1).max(120).optional(),
  source_model: z.string().min(1).max(160).optional(),
  source_ide: z.string().min(1).max(120).optional(),
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

function readEnv(...keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

function inferIde(input: TimeStampInput) {
  const explicit = input.source_ide?.trim();
  if (explicit) return explicit;
  const client = input.source_client?.trim().toLowerCase() || readEnv("MASTER_MOLD_SOURCE_CLIENT", "TRICHAT_SOURCE_CLIENT")?.toLowerCase() || "";
  if (client.includes("codex")) return "codex";
  if (client.includes("claude")) return "claude";
  if (client.includes("cursor")) return "cursor";
  if (client.includes("copilot")) return "github-copilot";
  if (client.includes("gemini")) return "gemini";
  return readEnv("MASTER_MOLD_SOURCE_IDE", "TRICHAT_SOURCE_IDE");
}

export function timeStamp(input: TimeStampInput) {
  const timezone = input.timezone?.trim() || defaultTimezone();
  const locale = input.locale?.trim() || "en-US";
  const date = input.at ? new Date(input.at) : new Date();
  const hostname = os.hostname();
  const hostId = readEnv("MASTER_MOLD_HOST_ID", "TRICHAT_HOST_ID", "HOST_ID") || hostname;
  const sourceClient = input.source_client?.trim() || readEnv("MASTER_MOLD_SOURCE_CLIENT", "TRICHAT_SOURCE_CLIENT");
  const sourceAgent = input.source_agent?.trim() || readEnv("MASTER_MOLD_SOURCE_AGENT", "TRICHAT_SOURCE_AGENT");
  const sourceModel = input.source_model?.trim() || readEnv("MASTER_MOLD_SOURCE_MODEL", "TRICHAT_SOURCE_MODEL");
  const sourceIde = inferIde(input);
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
    host: {
      host_id: hostId,
      hostname,
      platform: process.platform,
      arch: process.arch,
      user: os.userInfo().username,
      pid: process.pid,
      cwd: process.cwd(),
    },
    actor: {
      source_client: sourceClient,
      source_agent: sourceAgent,
      source_model: sourceModel,
      source_ide: sourceIde,
    },
    provenance: {
      host_id: hostId,
      hostname,
      source_client: sourceClient,
      source_agent: sourceAgent,
      source_model: sourceModel,
      source_ide: sourceIde,
      observed_at: date.toISOString(),
      observed_at_unix_milliseconds: date.getTime(),
    },
  };
}
