import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Storage } from "./storage.js";
import {
  appendMemory,
  getMemory,
  memoryAppendSchema,
  memoryGetSchema,
  memorySearchSchema,
  searchMemory,
} from "./tools/memory.js";
import {
  applyTranscriptRetention,
  autoSquishControl,
  initializeAutoSquishDaemon,
  appendTranscript,
  getTranscriptPendingRuns,
  getTranscriptRunTimeline,
  logTranscript,
  squishTranscript,
  summarizeTranscript,
  transcriptAppendSchema,
  transcriptAutoSquishSchema,
  transcriptLogSchema,
  transcriptPendingRunsSchema,
  transcriptRetentionSchema,
  transcriptRunTimelineSchema,
  transcriptSquishSchema,
  transcriptSummarizeSchema,
} from "./tools/transcript.js";
import { adrCreateSchema, createAdr } from "./tools/adr.js";
import { whoKnows, whoKnowsSchema } from "./tools/who_knows.js";
import { policyEvaluateSchema, evaluatePolicy } from "./tools/policy.js";
import {
  runBegin,
  runBeginSchema,
  runEnd,
  runEndSchema,
  runStep,
  runStepSchema,
  runTimeline,
  runTimelineSchema,
} from "./tools/run.js";
import { mutationCheck, mutationCheckSchema } from "./tools/idempotency.js";
import {
  preflightCheck,
  preflightCheckSchema,
  postflightVerify,
  postflightVerifySchema,
} from "./tools/verification.js";
import { acquireLock, lockAcquireSchema, lockReleaseSchema, releaseLock } from "./tools/locks.js";
import {
  knowledgeDecay,
  knowledgeDecaySchema,
  knowledgePromote,
  knowledgePromoteSchema,
  retrievalHybrid,
  retrievalHybridSchema,
} from "./tools/knowledge.js";
import { decisionLink, decisionLinkSchema } from "./tools/decision.js";
import {
  healthPolicy,
  healthPolicySchema,
  healthStorage,
  healthStorageSchema,
  healthTools,
  healthToolsSchema,
} from "./tools/health.js";
import {
  incidentOpen,
  incidentOpenSchema,
  incidentTimeline,
  incidentTimelineSchema,
} from "./tools/incident.js";
import { queryPlan, queryPlanSchema } from "./tools/query_plan.js";
import { migrationStatus, migrationStatusSchema } from "./tools/migration.js";
import { runIdempotentMutation } from "./tools/mutation.js";
import { inboxEnqueue, inboxEnqueueSchema, inboxList, inboxListSchema } from "./tools/inbox.js";
import {
  taskClaim,
  taskClaimSchema,
  taskComplete,
  taskCompleteSchema,
  taskCreate,
  taskCreateSchema,
  taskFail,
  taskFailSchema,
  taskHeartbeat,
  taskHeartbeatSchema,
  taskList,
  taskListSchema,
  taskSummary,
  taskSummarySchema,
  taskTimeline,
  taskTimelineSchema,
  taskRetry,
  taskRetrySchema,
  taskAutoRetryControl,
  taskAutoRetrySchema,
  initializeTaskAutoRetryDaemon,
} from "./tools/task.js";
import {
  imprintAutoSnapshotControl,
  imprintAutoSnapshotSchema,
  imprintBootstrap,
  imprintBootstrapSchema,
  imprintProfileGet,
  imprintProfileGetSchema,
  imprintProfileSet,
  imprintProfileSetSchema,
  imprintSnapshot,
  imprintSnapshotSchema,
  initializeImprintAutoSnapshotDaemon,
} from "./tools/imprint.js";
import { startStdioTransport } from "./transports/stdio.js";
import { startHttpTransport } from "./transports/http.js";
import { truncate } from "./utils.js";
import {
  listBuiltinDomainPacks,
  parseEnabledDomainPackIds,
  registerDomainPacks,
} from "./domain-packs/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.env.DOTENV_CONFIG_PATH
  ? path.resolve(process.env.DOTENV_CONFIG_PATH)
  : path.join(repoRoot, ".env");
dotenv.config({ path: envPath });

const storagePathEnv = process.env.ANAMNESIS_HUB_DB_PATH ?? process.env.MCP_HUB_DB_PATH;
const storagePath = storagePathEnv
  ? path.resolve(storagePathEnv)
  : path.join(repoRoot, "data", "hub.sqlite");
const storage = new Storage(storagePath);
storage.init();
initializeAutoSquishDaemon(storage);
initializeTaskAutoRetryDaemon(storage);

const SERVER_NAME = "mcplayground-core-template";
const SERVER_VERSION = "1.0.0";

const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

type ToolEntry = {
  schema: z.ZodTypeAny;
  tool: Tool;
  handler: (input: any) => Promise<unknown> | unknown;
};

const toolRegistry = new Map<string, ToolEntry>();

function registerTool(name: string, description: string, schema: z.ZodTypeAny, handler: ToolEntry["handler"]) {
  const tool: Tool = {
    name,
    description,
    inputSchema: zodToJsonSchema(schema, { $refStrategy: "none" }) as Tool["inputSchema"],
  };
  toolRegistry.set(name, { schema, tool, handler });
}

registerTool("memory.append", "Append distilled long-term memory content.", memoryAppendSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "memory.append",
    mutation: input.mutation,
    payload: input,
    execute: () => appendMemory(storage, input),
  })
);

registerTool("memory.search", "Search long-term memory using lexical matching.", memorySearchSchema, (input) =>
  searchMemory(storage, input)
);

registerTool("memory.get", "Fetch a memory by id for deterministic debugging.", memoryGetSchema, (input) =>
  getMemory(storage, input)
);

registerTool(
  "imprint.inbox.enqueue",
  "Enqueue an autonomous inbox task payload for local worker processing.",
  inboxEnqueueSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "imprint.inbox.enqueue",
      mutation: input.mutation,
      payload: input,
      execute: () => inboxEnqueue(repoRoot, input),
    })
);

registerTool(
  "imprint.inbox.list",
  "List local inbox task payload files by status directory.",
  inboxListSchema,
  (input) => inboxList(repoRoot, input)
);

registerTool(
  "imprint.profile_set",
  "Upsert durable local identity/profile instructions for autonomous agents.",
  imprintProfileSetSchema,
  (input) => imprintProfileSet(storage, input)
);

registerTool(
  "imprint.profile_get",
  "Read the durable local identity/profile instructions.",
  imprintProfileGetSchema,
  (input) => imprintProfileGet(storage, input)
);

registerTool(
  "imprint.snapshot",
  "Capture a local continuity snapshot (storage/tool/profile context) to SQLite and optional JSON.",
  imprintSnapshotSchema,
  (input) =>
    imprintSnapshot(storage, input, {
      repo_root: repoRoot,
      server_name: SERVER_NAME,
      server_version: SERVER_VERSION,
      get_tool_names: () => Array.from(toolRegistry.keys()),
    })
);

registerTool(
  "imprint.bootstrap",
  "Generate deterministic startup context from local profile, memories, transcript lines, and snapshots.",
  imprintBootstrapSchema,
  (input) =>
    imprintBootstrap(storage, input, {
      repo_root: repoRoot,
      server_name: SERVER_NAME,
      server_version: SERVER_VERSION,
      get_tool_names: () => Array.from(toolRegistry.keys()),
    })
);

registerTool(
  "imprint.auto_snapshot",
  "Manage interval-based continuity snapshots (status/start/stop/run_once).",
  imprintAutoSnapshotSchema,
  (input) =>
    imprintAutoSnapshotControl(storage, input, {
      repo_root: repoRoot,
      server_name: SERVER_NAME,
      server_version: SERVER_VERSION,
      get_tool_names: () => Array.from(toolRegistry.keys()),
    })
);

registerTool("transcript.log", "Log raw transcript lines into working memory.", transcriptLogSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "transcript.log",
    mutation: input.mutation,
    payload: input,
    execute: () => logTranscript(storage, input),
  })
);

registerTool("transcript.squish", "Squish raw transcript lines into distilled memories.", transcriptSquishSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "transcript.squish",
    mutation: input.mutation,
    payload: input,
    execute: () => squishTranscript(storage, input),
  })
);

registerTool(
  "transcript.run_timeline",
  "Read ordered transcript lines for a run with optional filters.",
  transcriptRunTimelineSchema,
  (input) => getTranscriptRunTimeline(storage, input)
);

registerTool(
  "transcript.pending_runs",
  "List run ids that still have unsquished transcript lines.",
  transcriptPendingRunsSchema,
  (input) => getTranscriptPendingRuns(storage, input)
);

registerTool(
  "transcript.auto_squish",
  "Manage interval-based backlog squishing (status/start/stop/run_once).",
  transcriptAutoSquishSchema,
  (input) => autoSquishControl(storage, input)
);

registerTool(
  "transcript.retention",
  "Apply retention policy for old transcript lines with optional dry-run mode.",
  transcriptRetentionSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "transcript.retention",
      mutation: input.mutation,
      payload: input,
      execute: () => applyTranscriptRetention(storage, input),
    })
);

registerTool("transcript.append", "Append a transcript entry with actor attribution.", transcriptAppendSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "transcript.append",
    mutation: input.mutation,
    payload: input,
    execute: () => appendTranscript(storage, input),
  })
);

registerTool(
  "transcript.summarize",
  "Generate a deterministic local summary for a transcript session and store it as a memory note.",
  transcriptSummarizeSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "transcript.summarize",
      mutation: input.mutation,
      payload: input,
      execute: () => summarizeTranscript(storage, input),
    })
);

registerTool("adr.create", "Create an ADR markdown file and record it in local storage.", adrCreateSchema, (input) =>
  runIdempotentMutation({
    storage,
    tool_name: "adr.create",
    mutation: input.mutation,
    payload: input,
    execute: () => createAdr(storage, input, repoRoot),
  })
);

registerTool(
  "who_knows",
  "Search local notes and transcripts in the shared MCP knowledge base.",
  whoKnowsSchema,
  (input) => whoKnows(storage, input)
);

registerTool(
  "knowledge.query",
  "Query local notes and transcripts in the shared MCP knowledge base.",
  whoKnowsSchema,
  (input) => whoKnows(storage, input)
);

registerTool(
  "policy.evaluate",
  "Evaluate a proposed action against local policy guardrails.",
  policyEvaluateSchema,
  (input) =>
    runIdempotentMutation({
      storage,
      tool_name: "policy.evaluate",
      mutation: input.mutation,
      payload: input,
      execute: () => evaluatePolicy(storage, input),
    })
);

registerTool("run.begin", "Start an append-only execution run ledger.", runBeginSchema, (input) =>
  runBegin(storage, input)
);

registerTool("run.step", "Append a step event to an execution run ledger.", runStepSchema, (input) =>
  runStep(storage, input)
);

registerTool("run.end", "Finalize an execution run ledger.", runEndSchema, (input) => runEnd(storage, input));

registerTool("run.timeline", "Read the timeline for an execution run ledger.", runTimelineSchema, (input) =>
  runTimeline(storage, input)
);

registerTool("task.create", "Create a durable local task record for autonomous execution.", taskCreateSchema, (input) =>
  taskCreate(storage, input)
);

registerTool("task.list", "List durable local tasks with optional status filtering.", taskListSchema, (input) =>
  taskList(storage, input)
);

registerTool("task.timeline", "Read ordered task lifecycle events from task_events.", taskTimelineSchema, (input) =>
  taskTimeline(storage, input)
);

registerTool(
  "task.summary",
  "Summarize task queue reliability state (counts, running leases, last failure).",
  taskSummarySchema,
  (input) => taskSummary(storage, input)
);

registerTool("task.claim", "Claim the next available task using a renewable lease.", taskClaimSchema, (input) =>
  taskClaim(storage, input)
);

registerTool("task.heartbeat", "Renew a leased task claim during long-running execution.", taskHeartbeatSchema, (input) =>
  taskHeartbeat(storage, input)
);

registerTool("task.complete", "Mark a running task as completed and release its lease.", taskCompleteSchema, (input) =>
  taskComplete(storage, input)
);

registerTool("task.fail", "Mark a running task as failed and release its lease.", taskFailSchema, (input) =>
  taskFail(storage, input)
);

registerTool("task.retry", "Requeue a failed task for retry with optional delay.", taskRetrySchema, (input) =>
  taskRetry(storage, input)
);

registerTool(
  "task.auto_retry",
  "Manage failed-task auto-retry daemon with deterministic backoff.",
  taskAutoRetrySchema,
  (input) => taskAutoRetryControl(storage, input)
);

registerTool(
  "mutation.check",
  "Validate idempotency metadata against recorded mutation journal state.",
  mutationCheckSchema,
  (input) => mutationCheck(storage, input)
);

registerTool(
  "preflight.check",
  "Validate prerequisites and invariants before mutating actions.",
  preflightCheckSchema,
  (input) => preflightCheck(input)
);

registerTool(
  "postflight.verify",
  "Verify post-action assertions after mutating actions.",
  postflightVerifySchema,
  (input) => postflightVerify(input)
);

registerTool("lock.acquire", "Acquire or renew a lease-based lock.", lockAcquireSchema, (input) =>
  acquireLock(storage, input)
);

registerTool("lock.release", "Release a lease-based lock.", lockReleaseSchema, (input) =>
  releaseLock(storage, input)
);

registerTool(
  "knowledge.promote",
  "Promote note/transcript/memory/transcript_line content into durable knowledge.",
  knowledgePromoteSchema,
  (input) => knowledgePromote(storage, input)
);

registerTool("knowledge.decay", "Apply trust tier decay policy to stale notes.", knowledgeDecaySchema, (input) =>
  knowledgeDecay(storage, input)
);

registerTool("retrieval.hybrid", "Run local hybrid retrieval with citation-rich results.", retrievalHybridSchema, (input) =>
  retrievalHybrid(storage, input)
);

registerTool("decision.link", "Record a decision and link it to an entity.", decisionLinkSchema, (input) =>
  decisionLink(storage, input)
);

registerTool("health.tools", "Check tool registry health.", healthToolsSchema, () =>
  healthTools(Array.from(toolRegistry.keys()))
);

registerTool("health.storage", "Check local storage health.", healthStorageSchema, () =>
  healthStorage(storage)
);

registerTool("health.policy", "Check policy subsystem health and guardrails.", healthPolicySchema, () =>
  healthPolicy()
);

registerTool("incident.open", "Create a local incident record with opening timeline event.", incidentOpenSchema, (input) =>
  incidentOpen(storage, input)
);

registerTool("incident.timeline", "Read incident timeline events.", incidentTimelineSchema, (input) =>
  incidentTimeline(storage, input)
);

registerTool("query.plan", "Produce a confidence-scored query plan with evidence citations.", queryPlanSchema, (input) =>
  queryPlan(storage, input)
);

registerTool("migration.status", "Read applied schema migration versions and metadata.", migrationStatusSchema, () =>
  migrationStatus(storage)
);

const startupArgs = process.argv.slice(2);
const requestedDomainPacks = parseEnabledDomainPackIds(
  getArgValue(startupArgs, "--domain-packs") ?? process.env.MCP_DOMAIN_PACKS
);
const domainPackRegistration = registerDomainPacks(requestedDomainPacks, {
  storage,
  repo_root: repoRoot,
  server_name: SERVER_NAME,
  server_version: SERVER_VERSION,
  register_tool: registerTool,
  run_idempotent_mutation: runIdempotentMutation,
});

if (domainPackRegistration.unknown.length > 0) {
  const available = listBuiltinDomainPacks().map((pack) => pack.id);
  console.warn(
    `[domain-packs] unknown pack ids: ${domainPackRegistration.unknown.join(", ")}; available: ${available.join(", ") || "none"}`
  );
}

if (domainPackRegistration.registered.length > 0) {
  console.error(`[domain-packs] enabled: ${domainPackRegistration.registered.join(", ")}`);
}

initializeImprintAutoSnapshotDaemon(storage, {
  repo_root: repoRoot,
  server_name: SERVER_NAME,
  server_version: SERVER_VERSION,
  get_tool_names: () => Array.from(toolRegistry.keys()),
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Array.from(toolRegistry.values()).map((entry) => entry.tool),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const entry = toolRegistry.get(name);
  if (!entry) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const parsed = entry.schema.parse(args ?? {});
    const result = await entry.handler(parsed);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (error) {
    const message = truncate(error instanceof Error ? error.message : String(error));
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
});

async function main() {
  const args = process.argv.slice(2);
  const httpEnabled = args.includes("--http") || process.env.MCP_HTTP === "1";

  if (httpEnabled) {
    const port = Number(getArgValue(args, "--http-port") ?? process.env.MCP_HTTP_PORT ?? 8787);
    const host = getArgValue(args, "--http-host") ?? process.env.MCP_HTTP_HOST ?? "127.0.0.1";
    const allowedOriginsEnv =
      process.env.MCP_HTTP_ALLOWED_ORIGINS ?? "http://localhost,http://127.0.0.1";
    const allowedOrigins = allowedOriginsEnv.split(",").map((origin) => origin.trim()).filter(Boolean);

    await startHttpTransport(server, {
      port,
      host,
      allowedOrigins,
      bearerToken: process.env.MCP_HTTP_BEARER_TOKEN ?? null,
    });
  } else {
    await startStdioTransport(server);
  }
}

function getArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
