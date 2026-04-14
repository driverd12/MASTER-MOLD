#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectAdapterArtifacts, detectTrainerAvailability } from "./local_adapter_lane.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = path.join(REPO_ROOT, "data", "training", "model_registry.json");

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 128;
const DEFAULT_ACCEPTANCE = {
  min_reward_score: 75,
  min_delta_vs_baseline: -5,
  max_test_loss: 8,
  require_generate_smoke: true,
  require_artifacts: true,
};

export const PROMOTION_CHALLENGES = [
  {
    case_id: "json-control-plane",
    title: "Return structured JSON for a control-plane risk",
    prompt:
      'Return only minified JSON with keys "risk" and "fix". The risk must mention stale state. The fix must mention truthful ready status.',
    mode: "json_object",
    keywords: ["stale", "ready", "status"],
  },
  {
    case_id: "two-item-hardening",
    title: "List exactly two hardening tasks",
    prompt:
      "List exactly two numbered hardening tasks for a local-first MCP control plane. Do not add any intro or outro.",
    mode: "numbered_pair",
    keywords: ["router", "office", "storage", "autonomy", "watchdog", "permissions"],
  },
  {
    case_id: "single-line-command",
    title: "Produce a bounded shell command",
    prompt: "Return one single-line shell command that prints the Node.js version. No explanation.",
    mode: "single_line_command",
    keywords: ["node", "--version"],
  },
  {
    case_id: "bridge-truthfulness",
    title: "Explain bridge truthfulness briefly",
    prompt: "In two sentences, explain why a configured-but-offline provider bridge should not be shown as ready.",
    mode: "two_sentence_explanation",
    keywords: ["configured", "offline", "ready", "bridge"],
  },
];

function parseArgs(argv) {
  const args = {
    manifestPath: "",
    reportPath: "",
    rewardFile: "",
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--manifest") {
      args.manifestPath = argv[++index] ?? "";
    } else if (token === "--report-path") {
      args.reportPath = argv[++index] ?? "";
    } else if (token === "--reward-file") {
      args.rewardFile = argv[++index] ?? "";
    } else if (token === "--max-tokens") {
      args.maxTokens = Math.max(16, Number.parseInt(argv[++index] ?? "", 10) || DEFAULT_MAX_TOKENS);
    } else if (token === "--timeout-ms") {
      args.timeoutMs = Math.max(10_000, Number.parseInt(argv[++index] ?? "", 10) || DEFAULT_TIMEOUT_MS);
    } else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node ./scripts/local_adapter_eval.mjs --manifest <path> --report-path <path> --reward-file <path>",
      "",
      "Notes:",
      "  This runs deterministic MLX companion-model prompts against the base model and adapter.",
    ].join("\n") + "\n"
  );
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeText(filePath, text) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text), "utf8");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function latestManifestPath() {
  const registry = readJson(REGISTRY_PATH);
  const latest = Array.isArray(registry?.runs) ? registry.runs[0] : null;
  if (latest?.manifest_path && fs.existsSync(latest.manifest_path)) {
    return latest.manifest_path;
  }
  return null;
}

function normalizeText(value) {
  return String(value || "").replace(/\r/g, "").trim();
}

function wordCount(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(Boolean).length;
}

function sentenceCount(text) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean).length;
}

function countEnumeratedItems(text) {
  const matches = normalizeText(text).match(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s+/gm);
  return matches ? matches.length : 0;
}

function extractJsonObject(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  try {
    return JSON.parse(normalized);
  } catch {}
  const match = normalized.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function keywordHits(text, keywords = []) {
  const haystack = normalizeText(text).toLowerCase();
  return keywords.filter((keyword) => haystack.includes(String(keyword).toLowerCase())).length;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...options,
  });
  return {
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function resolveAcceptanceContract(manifest) {
  const contract = manifest?.acceptance_contract?.promotion_eval;
  return {
    min_reward_score: Number.isFinite(contract?.min_reward_score) ? Number(contract.min_reward_score) : DEFAULT_ACCEPTANCE.min_reward_score,
    min_delta_vs_baseline:
      Number.isFinite(contract?.min_delta_vs_baseline) ? Number(contract.min_delta_vs_baseline) : DEFAULT_ACCEPTANCE.min_delta_vs_baseline,
    max_test_loss: Number.isFinite(contract?.max_test_loss) ? Number(contract.max_test_loss) : DEFAULT_ACCEPTANCE.max_test_loss,
    require_generate_smoke: contract?.require_generate_smoke !== false,
    require_artifacts: contract?.require_artifacts !== false,
  };
}

function readTrainingMetrics(manifest, runDir) {
  const metricsPath =
    String(manifest?.training_result?.training_metrics_path || "").trim() || path.join(runDir, "adapter", "training_metrics.json");
  const payload = readJson(metricsPath) || {};
  const parsed = payload?.parsed_metrics && typeof payload.parsed_metrics === "object" ? payload.parsed_metrics : {};
  return {
    metrics_path: metricsPath,
    payload,
    parsed_metrics: parsed,
    test_loss: Number.isFinite(parsed?.test_loss) ? Number(parsed.test_loss) : null,
    final_val_loss: Number.isFinite(parsed?.final_val_loss) ? Number(parsed.final_val_loss) : null,
    final_train_loss: Number.isFinite(parsed?.final_train_loss) ? Number(parsed.final_train_loss) : null,
    generate_smoke_ok: payload?.generate_smoke?.ok === true || manifest?.training_result?.generate_smoke?.ok === true,
  };
}

function runGeneration({ pythonPath, modelPath, adapterPath, prompt, maxTokens, timeoutMs }) {
  const generatorPath = path.join(path.dirname(pythonPath), "mlx_lm.generate");
  const startedAt = Date.now();
  const args = [
    "--model",
    modelPath,
    "--prompt",
    prompt,
    "--max-tokens",
    String(maxTokens),
    "--temp",
    "0",
    "--verbose",
    "False",
  ];
  if (adapterPath) {
    args.splice(2, 0, "--adapter-path", adapterPath);
  }
  const result = runCapture(generatorPath, args, { timeoutMs });
  const durationMs = Date.now() - startedAt;
  const output = normalizeText(result.stdout);
  return {
    ok: result.ok && output.length > 0,
    output,
    duration_ms: durationMs,
    stderr: normalizeText(result.stderr),
    error: result.ok ? null : normalizeText(result.stderr || result.error || "generation_failed"),
    command_preview: `${shellQuote(generatorPath)} ${args.map((entry) => shellQuote(entry)).join(" ")}`,
  };
}

export function scoreChallengeOutput(challenge, output) {
  const text = normalizeText(output);
  const reasons = [];
  let score = 0;
  if (!text) {
    return { score: 0, max_score: 25, reasons: ["output.empty"] };
  }
  score += 5;
  if (challenge.mode === "json_object") {
    const payload = extractJsonObject(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { score, max_score: 25, reasons: [...reasons, "json.invalid"] };
    }
    if (typeof payload.risk === "string") score += 6;
    else reasons.push("json.risk_missing");
    if (typeof payload.fix === "string") score += 6;
    else reasons.push("json.fix_missing");
    const hits = keywordHits(`${payload.risk || ""} ${payload.fix || ""}`, challenge.keywords);
    score += Math.min(8, hits * 3);
    if (hits === 0) reasons.push("json.keywords_missing");
  } else if (challenge.mode === "numbered_pair") {
    const itemCount = countEnumeratedItems(text);
    if (itemCount === 2) score += 10;
    else reasons.push(`list.count_${itemCount}`);
    const hits = keywordHits(text, challenge.keywords);
    score += Math.min(10, hits * 2);
    if (hits === 0) reasons.push("list.keywords_missing");
  } else if (challenge.mode === "single_line_command") {
    if (!text.includes("\n")) score += 5;
    else reasons.push("command.multiline");
    if (/\bnode\b/.test(text)) score += 5;
    else reasons.push("command.node_missing");
    if (/(?:--version|\s-v\b)/.test(text)) score += 5;
    else reasons.push("command.version_flag_missing");
    if (!/[.!?]/.test(text) && wordCount(text) <= 8) score += 5;
    else reasons.push("command.too_chatty");
  } else if (challenge.mode === "two_sentence_explanation") {
    const sentences = sentenceCount(text);
    if (sentences >= 1 && sentences <= 2) score += 5;
    else reasons.push(`explanation.sentence_count_${sentences}`);
    const hits = keywordHits(text, challenge.keywords);
    score += Math.min(10, hits * 2.5);
    if (hits < 3) reasons.push("explanation.keywords_missing");
    if (/\btruth|truthful|mislead|misleading|signal|state\b/i.test(text)) score += 5;
    else reasons.push("explanation.truth_signal_missing");
  }
  return {
    score: Math.max(0, Math.min(25, score)),
    max_score: 25,
    reasons,
  };
}

export function summarizeEvaluation({ challengeResults, trainingMetrics, acceptance, artifacts }) {
  const baseTotal = challengeResults.reduce((sum, entry) => sum + entry.base.score, 0);
  const adapterTotal = challengeResults.reduce((sum, entry) => sum + entry.adapter.score, 0);
  const delta = Number((adapterTotal - baseTotal).toFixed(2));
  const blockers = [];
  if (acceptance.require_artifacts && artifacts.all_present !== true) {
    blockers.push("adapter_artifacts_missing");
  }
  if (acceptance.require_generate_smoke && trainingMetrics.generate_smoke_ok !== true) {
    blockers.push("training_generate_smoke_failed");
  }
  if (!Number.isFinite(trainingMetrics.test_loss)) {
    blockers.push("training_test_loss_missing");
  } else if (trainingMetrics.test_loss > acceptance.max_test_loss) {
    blockers.push("training_test_loss_above_gate");
  }
  if (adapterTotal < acceptance.min_reward_score) {
    blockers.push("adapter_reward_below_gate");
  }
  if (delta < acceptance.min_delta_vs_baseline) {
    blockers.push("adapter_delta_below_gate");
  }
  return {
    accepted: blockers.length === 0,
    reward_score: Number(adapterTotal.toFixed(2)),
    baseline_score: Number(baseTotal.toFixed(2)),
    delta_score: delta,
    max_score: challengeResults.reduce((sum, entry) => sum + entry.adapter.max_score, 0),
    test_loss: trainingMetrics.test_loss,
    final_val_loss: trainingMetrics.final_val_loss,
    final_train_loss: trainingMetrics.final_train_loss,
    blockers,
  };
}

function evaluateManifest(manifest, options) {
  const runDir = path.dirname(options.manifestPath);
  const trainer = detectTrainerAvailability();
  if (trainer.trainer_ready !== true || !trainer.python_path) {
    throw new Error("Local MLX trainer backend is not ready. Run `npm run local:training:bootstrap` first.");
  }
  const trainingTarget = manifest?.training_target && typeof manifest.training_target === "object" ? manifest.training_target : {};
  const modelPath =
    String(trainingTarget.resolved_model_path || trainingTarget.resolved_model_ref || "").trim() ||
    String(trainingTarget.requested_model_ref || "").trim();
  if (!modelPath) {
    throw new Error("The training manifest does not include a resolved companion model path.");
  }
  const adapterPath = String(manifest?.training_result?.adapter_path || "").trim() || path.join(runDir, "adapter");
  const artifacts = detectAdapterArtifacts(adapterPath);
  const trainingMetrics = readTrainingMetrics(manifest, runDir);
  const acceptance = resolveAcceptanceContract(manifest);

  const challengeResults = PROMOTION_CHALLENGES.map((challenge) => {
    const base = runGeneration({
      pythonPath: trainer.python_path,
      modelPath,
      adapterPath: null,
      prompt: challenge.prompt,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
    });
    const adapter = runGeneration({
      pythonPath: trainer.python_path,
      modelPath,
      adapterPath,
      prompt: challenge.prompt,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
    });
    return {
      case_id: challenge.case_id,
      title: challenge.title,
      prompt: challenge.prompt,
      base: {
        ...base,
        ...scoreChallengeOutput(challenge, base.output),
      },
      adapter: {
        ...adapter,
        ...scoreChallengeOutput(challenge, adapter.output),
      },
    };
  });

  return {
    trainer,
    artifacts,
    trainingMetrics,
    acceptance,
    challengeResults,
    summary: summarizeEvaluation({
      challengeResults,
      trainingMetrics,
      acceptance,
      artifacts,
    }),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.manifestPath || latestManifestPath();
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error("No prepared local adapter manifest found. Run prepare and train first.");
  }
  if (!args.reportPath || !args.rewardFile) {
    throw new Error("--report-path and --reward-file are required.");
  }
  const manifest = readJson(manifestPath);
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`Could not read manifest at ${manifestPath}`);
  }

  const evaluation = evaluateManifest(manifest, {
    manifestPath,
    maxTokens: args.maxTokens,
    timeoutMs: args.timeoutMs,
  });
  const report = {
    generated_at: new Date().toISOString(),
    manifest_path: manifestPath,
    run_id: manifest.run_id ?? null,
    candidate_id: manifest.candidate_id ?? null,
    base_model: manifest.base_model ?? null,
    training_target: manifest.training_target ?? null,
    adapter_path: manifest?.training_result?.adapter_path ?? null,
    acceptance: evaluation.acceptance,
    artifacts: evaluation.artifacts,
    trainer: evaluation.trainer,
    training_metrics: evaluation.trainingMetrics,
    summary: evaluation.summary,
    challenge_results: evaluation.challengeResults,
  };
  writeJson(args.reportPath, report);
  writeText(args.rewardFile, `${evaluation.summary.reward_score}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!evaluation.summary.accepted) {
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  }
}
