import { agenticDomainPack } from "./agentic.js";
import {
  DomainPack,
  DomainPackContext,
  DomainPackRegistrationContext,
  DomainPackRegistrationResult,
} from "./types.js";

const BUILTIN_DOMAIN_PACKS: Record<string, DomainPack> = {
  [agenticDomainPack.id]: agenticDomainPack,
};

const DEFAULT_DOMAIN_PACK_IDS = [agenticDomainPack.id];

export function listBuiltinDomainPacks(): DomainPack[] {
  return Object.values(BUILTIN_DOMAIN_PACKS)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function parseEnabledDomainPackIds(rawValue: string | undefined): string[] {
  const raw = String(rawValue ?? "").trim();
  if (!raw) {
    return [...DEFAULT_DOMAIN_PACK_IDS];
  }

  const ids = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (ids.includes("none")) {
    return [];
  }

  return Array.from(new Set(ids));
}

export function registerDomainPacks(
  requestedIds: string[],
  context: DomainPackRegistrationContext
): DomainPackRegistrationResult {
  const requested = Array.from(new Set(requestedIds.map((entry) => entry.trim().toLowerCase()).filter(Boolean)));
  const registered: string[] = [];
  const unknown: string[] = [];

  for (const id of requested) {
    const pack = BUILTIN_DOMAIN_PACKS[id];
    if (!pack) {
      unknown.push(id);
      continue;
    }
    const packContext: DomainPackContext = {
      ...context,
      register_planner_hook: (hook) => context.register_planner_hook(id, hook),
      register_verifier_hook: (hook) => context.register_verifier_hook(id, hook),
    };
    pack.register(packContext);
    registered.push(id);
  }

  return {
    requested,
    registered,
    unknown,
  };
}
