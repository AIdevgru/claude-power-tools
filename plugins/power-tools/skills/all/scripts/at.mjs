#!/usr/bin/env node
// Turns a clock time into the next time the clock shows it, as a one-time cron expression.
//
//   node at.mjs 5:30      prints   cron: 30 5 10 11 *
//                                  when: Tue, Nov 10, 5:30 AM EST
//
// Reads 5:30, 05:30, 17:30, 5:30am, 5:30 pm, 7pm and 7. Without am or pm it's a 24-hour clock.
// The time is always in the future: a time that has already passed today means tomorrow.
// Exit 1 means the time couldn't be read.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Returns { hour, minute } on a 24-hour clock, or null.
export function parseClock(text) {
  const m = String(text || "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (minute > 59) return null;
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[3].startsWith("p") ? 12 : 0);
  } else if (hour > 23) return null;
  return { hour, minute };
}

// The next local Date, after now, at that hour and minute.
export function nextRun({ hour, minute }, now = new Date()) {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

// Pins minute, hour, day and month, so the expression matches one day of the year.
export const cronFor = (d) => `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;

export const describe = (d) =>
  d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

function main(argv) {
  const text = argv.join(" ");
  const clock = parseClock(text);
  if (!clock) {
    console.log(`Couldn't read the time "${text}". Use a clock time such as 5:30, 5:30am or 17:30.`);
    process.exitCode = 1;
    return;
  }
  const at = nextRun(clock);
  console.log(`cron: ${cronFor(at)}`);
  console.log(`when: ${describe(at)}`);
}

// Compare real paths: a linked install runs this through a junction or symlink.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
