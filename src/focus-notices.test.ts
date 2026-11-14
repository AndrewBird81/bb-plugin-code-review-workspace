import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { focusTemplates } from "../lib/focus-templates";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const ids = ["docs", "rules", "bugs", "errors", "tests", "types", "security"];

test("every shipped focus template carries its pinned source, individual notice, header, and license", () => {
  expect(focusTemplates.map(({ id }) => id)).toEqual(ids);
  const files = readdirSync(new URL("lib/focus-templates/", root)).filter((name) => name.endsWith(".ts") && name !== "index.ts");
  expect(files.sort()).toEqual(ids.map((id) => `${id}.ts`).sort());
  const notices = read("THIRD_PARTY_NOTICES.md");
  for (const template of focusTemplates) {
    const file = `${template.id}.ts`;
    const entry = notices.split(`## ${template.label} template\n`)[1]?.split("\n## ")[0];
    expect(entry).toBeTruthy();
    expect(template.sourceSha).toMatch(/^[a-f0-9]{40}$/);
    expect(template.source).toContain(`/blob/${template.sourceSha}/`);
    expect(entry).toContain(template.source);
    expect(entry).toContain(template.sourceSha);
    expect(entry).toContain(template.holder);
    expect(entry).toContain(`lib/focus-templates/${file}`);
    expect(template.licenseFile).toMatch(/^LICENSES\/[^/]+\.txt$/);
    expect(entry).toContain(template.licenseFile);
    expect(read(template.licenseFile)).toContain(template.license === "MIT" ? "Permission is hereby granted" : "TERMS AND CONDITIONS");
    const header = read(`lib/focus-templates/${file}`).split("export const")[0].trim().split("\n");
    expect(header).toHaveLength(3);
    expect(header[0]).toContain(template.source);
    expect(header[0]).toContain(`@ ${template.sourceSha}`);
    expect(header[1]).toBe(`// Licensed under ${template.license}. See THIRD_PARTY_NOTICES.md.`);
    expect(header[2]).toMatch(/^\/\/ Changed: .+/);
    expect(template.instructions.trim().length).toBeGreaterThan(0);
    expect(template.instructions.length).toBeLessThanOrEqual(8000);
    // Repo rules may name the generic instruction-file example, not the model/vendor.
    expect(template.instructions.replaceAll("CLAUDE.md", "")).not.toMatch(/anthropic|claude|codex|Task.tool|request access|licensed under|subagent|\bgh\b/i);
    expect(template.instructions).not.toMatch(/add_draft_comment|submit_focus_findings|\bupstream\b/i);
  }
  const hashes = {
    "Apache-2.0-claude-plugins-official.txt": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    "MIT-anthropics-claude-code-security-review.txt": "a9ac868c004c4cce26430b3117767b46397ba4fa25026b1e5ea6694b463baf4b",
  };
  for (const [file, hash] of Object.entries(hashes)) {
    // Verbatim upstream bytes, not normalized/reformatted copies.
    expect(createHash("sha256").update(readFileSync(new URL(`LICENSES/${file}`, root))).digest("hex")).toBe(hash);
  }
  expect(read("LICENSES/MIT-anthropics-claude-code-security-review.txt")).toContain("Copyright (c) 2025 Anthropic");
  for (const excluded of ["documentation-accuracy-reviewer", "pre-LICENSE", "anthropics/claude-code"]) expect(notices).toContain(excluded);
});
