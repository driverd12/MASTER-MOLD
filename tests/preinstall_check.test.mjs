import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREINSTALL_CHECK_PATH = path.join(REPO_ROOT, "scripts", "preinstall_check.mjs");

test("preinstall_check exits cleanly for the pinned runtime", () => {
  const output = execFileSync(process.execPath, [PREINSTALL_CHECK_PATH], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      MCP_PREINSTALL_NODE_VERSION: "v22.22.1",
      MCP_PREINSTALL_NPM_VERSION: "10.9.4",
    },
  });

  assert.equal(output, "");
});

test("preinstall_check fails fast with actionable remediation for unsupported runtimes", () => {
  try {
    execFileSync(process.execPath, [PREINSTALL_CHECK_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        MCP_PREINSTALL_NODE_VERSION: "v25.9.0",
        MCP_PREINSTALL_NPM_VERSION: "11.12.1",
      },
    });
    assert.fail("preinstall_check should exit non-zero for unsupported runtimes");
  } catch (error) {
    assert.equal(error.status, 1);
    assert.match(String(error.stderr || ""), /bootstrap:env:install/);
    assert.match(String(error.stderr || ""), /Node >=20 <23/);
    assert.match(String(error.stderr || ""), /npm >=10 <11/);
    assert.match(String(error.stderr || ""), /npm ci/);
  }
});
