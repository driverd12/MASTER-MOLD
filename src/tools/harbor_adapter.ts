/**
 * Harbor task format adapter.
 *
 * Imports Harbor benchmark task directories into MASTER MOLD benchmark suite
 * upsert payloads. Harbor tasks follow this layout:
 *
 *   tasks/<task_id>/
 *     task.toml          — task metadata (name, description)
 *     instruction.md     — agent prompt / instructions
 *     tests/
 *       test.sh          — evaluation script (writes score to /logs/reward.txt)
 *
 * This adapter reads that structure and emits a payload compatible with
 * benchmarkSuiteUpsertSchema so it can be fed directly to benchmark.suite_upsert.
 */

import fs from "node:fs";
import path from "node:path";

export interface HarborTask {
  task_id: string;
  name: string;
  description: string;
  instruction: string;
  test_command: string;
  reward_file_path: string;
}

export interface HarborImportResult {
  title: string;
  objective: string;
  project_dir: string;
  isolation_mode: "none";
  aggregate_metric_name: string;
  aggregate_metric_direction: "maximize";
  cases: Array<{
    case_id: string;
    title: string;
    command: string;
    metric_name: string;
    metric_direction: "maximize";
    metric_mode: "reward_file";
    reward_file_path: string;
    tags: string[];
  }>;
  tags: string[];
  metadata: Record<string, unknown>;
}

/**
 * Parse a minimal TOML subset (key = "value" lines) sufficient for Harbor task.toml files.
 * Handles string values in double or single quotes and bare values.
 */
function parseSimpleToml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Read a single Harbor task directory and return a HarborTask.
 */
export function readHarborTask(taskDir: string): HarborTask {
  const taskId = path.basename(taskDir);

  const tomlPath = path.join(taskDir, "task.toml");
  const tomlContent = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, "utf8") : "";
  const tomlData = parseSimpleToml(tomlContent);

  const instructionPath = path.join(taskDir, "instruction.md");
  const instruction = fs.existsSync(instructionPath) ? fs.readFileSync(instructionPath, "utf8").trim() : "";

  const testShPath = path.join(taskDir, "tests", "test.sh");
  const testCommand = fs.existsSync(testShPath) ? `bash ${testShPath}` : `echo "no test.sh found" && exit 1`;

  return {
    task_id: taskId,
    name: tomlData.name || taskId,
    description: tomlData.description || instruction.slice(0, 200) || `Harbor task: ${taskId}`,
    instruction,
    test_command: testCommand,
    reward_file_path: tomlData.reward_file || "/logs/reward.txt",
  };
}

/**
 * Scan a Harbor tasks root directory and return all discovered tasks.
 */
export function discoverHarborTasks(tasksRoot: string): HarborTask[] {
  if (!fs.existsSync(tasksRoot) || !fs.statSync(tasksRoot).isDirectory()) {
    return [];
  }
  const entries = fs.readdirSync(tasksRoot, { withFileTypes: true });
  const tasks: HarborTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      tasks.push(readHarborTask(path.join(tasksRoot, entry.name)));
    } catch {
      // skip malformed task directories
    }
  }
  return tasks.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

/**
 * Convert a set of Harbor tasks into a MASTER MOLD benchmark suite upsert payload.
 * The returned object can be spread into a benchmark.suite_upsert call after adding
 * the required `mutation` field.
 */
export function harborTasksToSuitePayload(
  tasks: HarborTask[],
  options?: {
    suite_title?: string;
    suite_objective?: string;
    project_dir?: string;
  },
): HarborImportResult {
  if (tasks.length === 0) {
    throw new Error("No Harbor tasks to import");
  }
  return {
    title: options?.suite_title || `Harbor import (${tasks.length} tasks)`,
    objective: options?.suite_objective || "Evaluate agent performance on Harbor benchmark tasks using reward_file scoring",
    project_dir: options?.project_dir || process.cwd(),
    isolation_mode: "none",
    aggregate_metric_name: "reward_score",
    aggregate_metric_direction: "maximize",
    cases: tasks.map((task) => ({
      case_id: task.task_id,
      title: task.name,
      command: task.test_command,
      metric_name: "reward_score",
      metric_direction: "maximize" as const,
      metric_mode: "reward_file" as const,
      reward_file_path: task.reward_file_path,
      tags: ["harbor", "imported"],
    })),
    tags: ["harbor", "autoagent", "imported"],
    metadata: {
      import_source: "harbor_adapter",
      task_count: tasks.length,
      imported_at: new Date().toISOString(),
    },
  };
}

/**
 * One-shot: scan a Harbor tasks directory and produce a ready-to-use suite payload.
 */
export function importHarborDirectory(
  tasksRoot: string,
  options?: {
    suite_title?: string;
    suite_objective?: string;
    project_dir?: string;
  },
): HarborImportResult {
  const tasks = discoverHarborTasks(tasksRoot);
  return harborTasksToSuitePayload(tasks, options);
}
