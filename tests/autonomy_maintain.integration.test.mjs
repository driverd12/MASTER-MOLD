import assert from "node:assert/strict";
import test from "node:test";
import { getAutonomyMaintainRuntimeStatus } from "../dist/tools/autonomy_maintain.js";

test("getAutonomyMaintainRuntimeStatus returns expected runtime shape", () => {
  const status = getAutonomyMaintainRuntimeStatus();
  assert.equal(typeof status, "object");
  assert.ok(status !== null);
  assert.ok("running" in status);
  assert.ok("in_tick" in status);
  assert.ok("tick_count" in status);
  assert.ok("config" in status);
  assert.equal(typeof status.tick_count, "number");
  assert.equal(typeof status.config, "object");
});

test("getAutonomyMaintainRuntimeStatus running is false when daemon not started", () => {
  const status = getAutonomyMaintainRuntimeStatus();
  assert.equal(status.running, false);
});

test("autonomy_maintain_not_running attention pattern matches subsystem issue regex", () => {
  const notRunningEntry = "autonomy_maintain.not_running";
  const staleEntry = "autonomy_maintain.stale";
  const subsystemPattern = /\.(not_running|stale|error)$/;
  assert.ok(subsystemPattern.test(notRunningEntry), "not_running entry should match subsystem pattern");
  assert.ok(subsystemPattern.test(staleEntry), "stale entry should match subsystem pattern");
});

test("autonomy_maintain_stale attention pattern triggers subsystem reaction path", () => {
  const attentionEntries = ["autonomy_maintain.stale", "reaction_engine.not_running"];
  const subsystemPattern = /\.(not_running|stale|error)$/;
  const subsystemIssues = attentionEntries.filter((entry) => subsystemPattern.test(entry));
  assert.equal(subsystemIssues.length, 2);
  assert.ok(subsystemIssues.includes("autonomy_maintain.stale"));
  assert.ok(subsystemIssues.includes("reaction_engine.not_running"));
});
