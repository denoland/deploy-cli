import { red, stripAnsiCode } from "@std/fmt/colors";
import { Temporal } from "temporal-polyfill";

import type { GlobalContext } from "./main.ts";

export function isInteractive(): boolean {
  return Deno.stdin.isTerminal();
}

export function requireInteractive(context: GlobalContext, hint: string): void {
  if (!isInteractive()) {
    error(
      context,
      `This command requires interactive input, but stdin is not a terminal.\n${hint}`,
    );
  }
}

export function error(
  context: GlobalContext,
  error: string,
  response?: Response,
): never {
  console.error();
  console.error(`${red("✗")} An error occurred:`);
  console.error(
    `  ${String(error ?? "Unknown error").replaceAll("\n", "\n  ")}`,
  );
  const trace = response?.headers.get("x-deno-trace-id");
  if (context.debug) {
    console.error(`  stack:\n${new Error().stack}`);
  }
  if (trace) {
    console.error(`  trace id: ${trace}`);
  }
  Deno.exit(1);
}

export function renderTemporalTimestamp(timestamp: string, hideDate = false) {
  function pad(n: number, width: number): string {
    return n.toString().padStart(width, "0");
  }

  const date = Temporal
    .Instant
    .from(timestamp)
    .toZonedDateTimeISO("UTC");
  const months = pad(date.month, 2);
  const days = pad(date.day, 2);
  const hours = pad(date.hour, 2);
  const minutes = pad(date.minute, 2);
  const seconds = pad(date.second, 2);
  const ms = (date.millisecond / 1000).toFixed(2).substring(2);

  const time = `${hours}:${minutes}:${seconds}.${ms}`;
  if (hideDate) return time;

  return `${date.year}-${months}-${days} ${time}`;
}

export const KIBIBYTE = 1024;
export const MEBIBYTE = KIBIBYTE * 1024;
export const GIBIBYTE = MEBIBYTE * 1024;

export const KILOBYTE = 1000;
export const MEGABYTE = KILOBYTE * 1000;
export const GIGABYTE = MEGABYTE * 1000;

export function formatSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  if (bytes >= GIBIBYTE) {
    return `${parseFloat((bytes / GIBIBYTE).toFixed(2))} GiB`;
  }

  if (bytes >= MEBIBYTE) {
    return `${parseFloat((bytes / MEBIBYTE).toFixed(2))} MiB`;
  }

  if (bytes >= KIBIBYTE) {
    return `${parseFloat((bytes / KIBIBYTE).toFixed(2))} KiB`;
  }

  return `${bytes} Bytes`;
}

export function parseSize(context: GlobalContext, size: string): number {
  const match = size.match(/^(\d+)(GB|MB|KB|GiB|MiB|KiB)$/i);
  if (!match) {
    error(
      context,
      "Invalid size format. Examples of valid size: '2gb', '1gib', '1000mb', '1024mib'",
    );
  }
  const [, numStr, unit] = match;
  const num = parseFloat(numStr);

  switch (unit.toLowerCase()) {
    case "gb":
      return num * GIGABYTE;
    case "mb":
      return num * MEGABYTE;
    case "kb":
      return num * KILOBYTE;
    case "gib":
      return num * GIBIBYTE;
    case "mib":
      return num * MEBIBYTE;
    case "kib":
      return num * KIBIBYTE;
  }

  throw new Error("unreachable");
}

/**
 * Format duration in ms to human readable string
 *
 * @example
 *   86400000 => 1d
 *    7200000 => 2h
 *     180000 => 3m
 *       4000 => 4s
 *          5 => 5ms
 *
 * @param ms
 */
export function formatDuration(ms: number): string {
  if (ms === 0) return "0s";

  const secondsMs = 1000;
  const minMs = 1000 * 60;
  const hoursMs = 1000 * 60 * 60;
  const daysMs = 1000 * 60 * 60 * 24;

  let str = "";
  let count = 0;

  const days = Math.floor(ms / daysMs);
  if (days > 0) {
    ms = ms - days * daysMs;
    str += `${days}d`;
    count++;
  }

  const hours = Math.floor(ms / hoursMs);
  if (hours > 0) {
    ms = ms - hours * hoursMs;
    if (count > 0) str += " ";
    str += `${hours}h`;
    count++;
  }

  if (count > 1 || (count > 0 && hours === 0)) return str;

  const mins = Math.floor(ms / minMs);
  if (mins > 0) {
    ms = ms - mins * minMs;
    if (count > 0) str += " ";
    str += `${mins}m`;
    count++;
  }
  if (count > 1 || (count > 0 && mins === 0)) return str;

  const seconds = Math.floor(ms / secondsMs);
  if (seconds > 0) {
    const tmp = ms - seconds * secondsMs;

    if (count < 1 && tmp > 0) {
      const v = Math.round((ms / 1000) * 10) / 10;
      if (count > 0) str += " ";
      str += `${v}s`;
      return str;
    }
    if (count > 0) str += " ";
    str += `${seconds}s`;
    ms = tmp;
    count++;
  }
  if (count > 1 || (count > 0 && seconds === 0)) return str;

  if (ms > 0) {
    if (count > 0) str += " ";
    const v = Math.round(ms * 100) / 100;
    str += `${v}ms`;
  }

  return str;
}

export type SubTable = {
  headers: string[];
  rows: string[][];
};

export function tablePrinter<T>(
  headers: string[],
  values: T[],
  transformer: (value: T) => string[],
  subtableGenerator?: (value: T) => SubTable | undefined,
) {
  const padding = headers.map((header) => header.length);

  const processed = values.map((value) => {
    const transformed = transformer(value);

    for (let i = 0; i < transformed.length; i++) {
      padding[i] = Math.max(padding[i], stripAnsiCode(transformed[i]).length);
    }

    const subtable = subtableGenerator?.(value);
    let processedSubtable: { padding: number[]; rows: string[][] } | undefined;

    if (subtable && subtable.rows.length > 0) {
      const subPadding = subtable.headers.map((header) => header.length);

      for (const row of subtable.rows) {
        for (let i = 0; i < row.length; i++) {
          subPadding[i] = Math.max(
            subPadding[i],
            stripAnsiCode(row[i]).length,
          );
        }
      }

      processedSubtable = { padding: subPadding, rows: subtable.rows };
    }

    return {
      row: transformed,
      subtable: subtable?.headers,
      processedSubtable,
    };
  });

  console.log(
    headers.map((header, i) => header.padEnd(padding[i])).join("   "),
  );

  for (let i = 0; i < processed.length; i++) {
    const { row, subtable, processedSubtable } = processed[i];

    console.log(row.map((field, i) => field.padEnd(padding[i])).join("   "));

    if (subtable && processedSubtable) {
      console.log(
        "  " +
          subtable
            .map((header, i) => header.padEnd(processedSubtable.padding[i]))
            .join("   "),
      );

      for (const subRow of processedSubtable.rows) {
        console.log(
          "  " +
            subRow
              .map((field, i) => field.padEnd(processedSubtable.padding[i]))
              .join("   "),
        );
      }

      if (i < processed.length - 1) {
        console.log();
      }
    }
  }
}
