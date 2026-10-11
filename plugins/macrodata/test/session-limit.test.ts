import { describe, test, expect } from "bun:test";
import { parseSessionLimitReset } from "../src/session-limit";

describe("parseSessionLimitReset", () => {
	test("returns null when the output has no session-limit message", () => {
		const now = new Date("2026-10-10T01:11:10Z");
		expect(parseSessionLimitReset("Journal entry logged.", now)).toBeNull();
		expect(parseSessionLimitReset("", now)).toBeNull();
		expect(parseSessionLimitReset("the server resets at 9pm", now)).toBeNull();
	});

	test("reads an am time with minutes in the named zone", () => {
		const now = new Date("2026-10-10T01:11:10Z");
		const reset = parseSessionLimitReset(
			"You've hit your session limit · resets 2:30am (Europe/London)",
			now,
		);
		expect(reset?.toISOString()).toBe("2026-10-10T01:30:00.000Z");
	});

	test("reads an hour-only time", () => {
		const now = new Date("2026-10-10T08:07:10Z");
		const reset = parseSessionLimitReset(
			"You've hit your session limit · resets 11am (Europe/London)",
			now,
		);
		expect(reset?.toISOString()).toBe("2026-10-10T10:00:00.000Z");
	});

	test("rolls to the next day when the time has already passed", () => {
		const now = new Date("2026-10-10T17:14:07Z");
		expect(
			parseSessionLimitReset("session limit · resets 9pm (Europe/London)", now)?.toISOString(),
		).toBe("2026-10-10T20:00:00.000Z");
		expect(
			parseSessionLimitReset("session limit · resets 5pm (Europe/London)", now)?.toISOString(),
		).toBe("2026-10-11T16:00:00.000Z");
	});

	test("treats 12am as midnight and 12pm as noon", () => {
		const now = new Date("2026-10-10T17:14:07Z");
		expect(
			parseSessionLimitReset("session limit · resets 12am (Europe/London)", now)?.toISOString(),
		).toBe("2026-10-10T23:00:00.000Z");
		expect(
			parseSessionLimitReset("session limit · resets 12pm (Europe/London)", now)?.toISOString(),
		).toBe("2026-10-11T11:00:00.000Z");
	});

	test("uses the process zone when the message names none or names one Intl rejects", () => {
		const now = new Date("2026-10-10T17:14:07Z");
		const local = new Intl.DateTimeFormat("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		for (const text of [
			"session limit · resets 9pm",
			"session limit · resets 9pm (Mars/Olympus)",
		]) {
			const reset = parseSessionLimitReset(text, now);
			expect(reset).not.toBeNull();
			expect(local.format(reset as Date)).toBe("21:00");
			expect((reset as Date).getTime()).toBeGreaterThan(now.getTime());
		}
	});
});
