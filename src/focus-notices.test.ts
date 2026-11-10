import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { docs } from "../lib/focus-templates/docs";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

test("every sourced focus template carries its pinned source, notice, header, and license", async () => {
  const files = readdirSync(new URL("lib/focus-templates/", root)).filter((name) => name.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);
  const notices = read("THIRD_PARTY_NOTICES.md");
  for (const file of files) {
    const exports = await import(`../lib/focus-templates/${file.slice(0, -3)}.ts`);
    for (const template of Object.values(exports) as typeof docs[]) {
      if (!template.source) continue;
      expect(template.sourceSha).toMatch(/^[a-f0-9]{40}$/);
      expect(notices).toContain(template.source);
      expect(notices).toContain(template.sourceSha);
      expect(notices).toContain(template.holder);
      expect(notices).toContain(`lib/focus-templates/${file}`);
      const repo = new URL(template.source).pathname.split("/")[2];
      const licenseFile = `LICENSES/${template.license}-${repo}.txt`;
      expect(notices).toContain(licenseFile);
      expect(read(licenseFile)).toContain("TERMS AND CONDITIONS");
      const header = read(`lib/focus-templates/${file}`).split("export const")[0];
      expect(header).toContain(template.source);
      expect(header).toContain(template.sourceSha);
      expect(header).toContain(`Licensed under ${template.license}`);
      expect(header).toContain("Changed:");
      expect(header).toContain("THIRD_PARTY_NOTICES.md");
      expect(template.instructions).not.toMatch(/anthropic|claude|CLAUDE\.md|Task.tool|request access|licensed under/i);
      expect(template.instructions).not.toMatch(/add_draft_comment|submit_focus_findings/);
    }
  }
  const license = readFileSync(new URL("LICENSES/Apache-2.0-claude-plugins-official.txt", root));
  // The plugin-directory LICENSE at docs.sourceSha, not a normalized/reformatted copy.
  expect(createHash("sha256").update(license).digest("hex")).toBe("cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30");
  for (const excluded of ["documentation-accuracy-reviewer", "pre-LICENSE", "anthropics/claude-code"]) expect(notices).toContain(excluded);
});
