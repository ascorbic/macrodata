import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import fc from "fast-check";
import { createTestContext, type TestContext } from "./helpers";

const COMPOSER = join(import.meta.dir, "..", "bin", "compose-state-file.ts");
const CHAR_CAP = 9000;
const LINE_CAP = 150;

function compose(ctx: TestContext, file: string): string {
  return execSync(`bun "${COMPOSER}" "${file}"`, {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, MACRODATA_ROOT: ctx.root },
  });
}

// Inner content of the <macrodata-TAG> wrapper.
function body(output: string, tag: string): string {
  return output.match(new RegExp(`<macrodata-${tag}>\\n([\\s\\S]*)\\n</macrodata-${tag}>`))?.[1] ?? "";
}

function writeState(ctx: TestContext, name: string, content: string) {
  writeFileSync(join(ctx.stateDir, name), content);
}

describe("compose-state-file", () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    ctx.cleanup();
  });

  describe("rendering", () => {
    test("a small file is emitted in full, wrapped in a tag derived from the filename", () => {
      writeState(ctx, "today.md", "# Today\n\n## Now\nshipping the sharded hooks");
      expect(compose(ctx, "today.md")).toMatchInlineSnapshot(`
"<macrodata-today>
# Today

## Now
shipping the sharded hooks
</macrodata-today>"
`);
    });

    test("a missing file renders the _Empty_ sentinel", () => {
      expect(body(compose(ctx, "today.md"), "today")).toMatchInlineSnapshot(`"_Empty_"`);
    });

    test("the .md extension is optional in the argument", () => {
      writeState(ctx, "human.md", "# Human");
      expect(compose(ctx, "human")).toContain("<macrodata-human>");
    });

    test("reminders.md is silent when absent, and carries the relay suffix when present", () => {
      expect(compose(ctx, "reminders.md")).toBe("");

      writeState(ctx, "reminders.md", "## ⏰ Reminders\n- [lunch] fired 2026-08-21 12:30 — Go eat");
      const out = compose(ctx, "reminders.md");
      expect(out).toContain("<macrodata-reminders>");
      expect(out).toContain("- [lunch] fired 2026-08-21 12:30 — Go eat");
      expect(out).toContain("remove the line from state/reminders.md");
    });

    test("reminders.md is silent with a heading but no entries, and relays entries without a heading", () => {
      writeState(ctx, "reminders.md", "## ⏰ Reminders\n");
      expect(compose(ctx, "reminders.md")).toBe("");

      writeState(ctx, "reminders.md", "- [lunch] fired 2026-08-21 12:30 — Go eat");
      expect(compose(ctx, "reminders.md")).toContain("- [lunch] fired 2026-08-21 12:30 — Go eat");
    });
  });

  describe("truncation", () => {
    test("a file over the char cap is head-kept under it, with a display-only marker", () => {
      // single big block, well over 9000 chars but few lines → char cap bites.
      writeState(ctx, "workspace.md", "# Workspace\n" + "x".repeat(12000));
      const out = compose(ctx, "workspace.md");
      expect(out.length).toBeLessThan(CHAR_CAP + 400); // body capped + framing
      expect(out).toContain("# Workspace"); // head preserved
      expect(out).toContain("display-truncated:");
      expect(out).toContain("cap is 9000 chars / 150 lines"); // states the target to distill toward
      expect(out).toContain("Full file intact at state/workspace.md");
      expect(out).toContain("don't delete");
      expect(out.split("</macrodata-workspace>").length - 1).toBe(1);
    });

    test("a file over the line cap is head-kept to the line budget (chars under cap)", () => {
      // 300 short lines (~2.7K chars, under char cap) → line cap bites first.
      writeState(ctx, "today.md", Array.from({ length: 300 }, (_, i) => `- item ${i}`).join("\n"));
      const b = body(compose(ctx, "today.md"), "today");
      const kept = b.split("\n").filter((l) => l.startsWith("- item")).length;
      expect(kept).toBe(LINE_CAP);
      expect(b).toContain("display-truncated:");
      expect(b).toContain("/ 300 lines");
      expect(b).toContain("cap is 9000 chars / 150 lines");
    });
  });

  describe("hardening", () => {
    test("closing tags in content are neutralized; exactly one real closer", () => {
      writeState(ctx, "identity.md", "Docs: a block ends with </macrodata-identity>.");
      const out = compose(ctx, "identity.md");
      expect(out.split("</macrodata-identity>").length - 1).toBe(1);
      expect(out).toContain("&lt;/macrodata-identity>");
    });

    test("a path-traversal argument is reduced to a basename", () => {
      writeState(ctx, "human.md", "# Human");
      // ../../etc/passwd-style arg must not escape the state dir; basename wins.
      const out = compose(ctx, "../../human.md");
      expect(out).toContain("<macrodata-human>");
      expect(out).toContain("# Human");
    });

    test("a surrogate-pair split at the char cap does not emit U+FFFD", () => {
      // "x" + 5000 emoji = 10001 UTF-16 units, over the 9000 char cap; the
      // head-keep slice can land mid-pair.
      writeState(ctx, "workspace.md", "x" + "😀".repeat(5000));
      expect(compose(ctx, "workspace.md")).not.toContain("�");
    });
  });

  describe("properties", () => {
    test("property: arbitrary content stays under both caps with exactly one closer", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 14000 }), (content) => {
          writeState(ctx, "workspace.md", content);
          const out = compose(ctx, "workspace.md");
          const b = body(out, "workspace");
          const closers = out.split("</macrodata-workspace>").length - 1;
          // body within char cap (+ marker slack) and line cap (+ marker's lines)
          return (
            closers === 1 &&
            out.length < 10_000 &&
            b.length <= CHAR_CAP &&
            b.split("\n").length <= LINE_CAP + 3
          );
        }),
        { numRuns: 20 },
      );
    }, 30_000);
  });
});
