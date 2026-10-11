/**
 * Claude Code in --print mode prints a single line and exits 1 when the
 * subscription's rolling window is spent:
 *   You've hit your session limit · resets 2:30am (Europe/London)
 * The time is wall-clock in the named zone, with minutes only when non-zero.
 */

const RESET_PATTERN = /limit[^\n]*?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)\n]+)\))?/i;

/**
 * The next instant at which the limit named in `output` resets, or null when
 * the output carries no such message. A DST change between `now` and the
 * reset shifts the result by an hour.
 */
export function parseSessionLimitReset(output: string, now: Date = new Date()): Date | null {
	const match = RESET_PATTERN.exec(output);
	if (!match) return null;

	const [, hourText, minuteText, meridiem, zone] = match;
	let hour = parseInt(hourText, 10) % 12;
	if (meridiem.toLowerCase() === "pm") hour += 12;
	const minute = minuteText ? parseInt(minuteText, 10) : 0;

	let delta = hour * 60 + minute - wallClockMinutes(now, zone);
	if (delta <= 0) delta += 24 * 60;

	const base = new Date(now);
	base.setUTCSeconds(0, 0);
	return new Date(base.getTime() + delta * 60_000);
}

function wallClockMinutes(date: Date, zone?: string): number {
	const options: Intl.DateTimeFormatOptions = {
		hour: "numeric",
		minute: "numeric",
		hourCycle: "h23",
	};
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone });
	} catch {
		formatter = new Intl.DateTimeFormat("en-GB", options);
	}
	const parts = formatter.formatToParts(date);
	const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	return part("hour") * 60 + part("minute");
}
