import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "node_modules/oxlint/bin/oxlint");

function lint(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "ai-funnel-lint-"));
  try {
    const fixture = join(directory, "fixture.tsx");
    writeFileSync(fixture, source);
    return spawnSync(
      process.execPath,
      [
        cli,
        "--config",
        join(root, ".oxlintrc.json"),
        "--format",
        "json",
        fixture,
      ],
      { cwd: root, encoding: "utf8" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Oxlint forbids em dashes in comments, strings, templates, and JSX", () => {
  const dash = String.fromCodePoint(0x2014);
  const result = lint(
    [
      `// Before${dash}after`,
      `export const text = "Before${dash}after";`,
      `export const template = \`Before${dash}after\`;`,
      `export const view = <span>Before${dash}after</span>;`,
    ].join("\n"),
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const { diagnostics } = JSON.parse(result.stdout);
  assert.equal(diagnostics.length, 4);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.code, "project(no-em-dash)");
    assert.equal(diagnostic.severity, "error");
  }
});

test("Oxlint allows ordinary punctuation and hyphens", () => {
  const result = lint(
    `// A provider-specific account.\nexport const text = "Before, after.";`,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
