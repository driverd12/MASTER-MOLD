# Domain Packs

## Purpose

Domain packs let you extend the core runtime with domain-specific tools while preserving one shared durability/governance foundation.

## Runtime Loading

Enable packs with either:

- environment variable: `MCP_DOMAIN_PACKS=cfd`
- CLI flag: `node dist/server.js --domain-packs cfd`

Multiple packs:

- `MCP_DOMAIN_PACKS=cfd,another-pack`

Disable all packs explicitly:

- `MCP_DOMAIN_PACKS=none`

## Framework Files

- `src/domain-packs/types.ts`: pack interfaces and registration context.
- `src/domain-packs/index.ts`: built-in registry, parser, and loader.
- `src/domain-packs/cfd.ts`: reference implementation.

## Pack Contract

A pack must export a `DomainPack` object:

- `id`: stable lowercase pack id.
- `title`: display name.
- `description`: short purpose statement.
- `register(context)`: function that registers namespaced tools.

`context` includes:

- `storage`: core storage adapter
- `repo_root`, `server_name`, `server_version`
- `register_tool(name, description, schema, handler)`
- `run_idempotent_mutation(...)`

## Tool Naming Rules

Use namespaced tool ids:

- good: `cfd.solve.start`
- good: `pharma.batch.validate`
- avoid: `solve.start` or `validate` (too generic)

## Recommended Pack Design

- Keep pack schemas deterministic and explicit.
- Include source attribution fields for traceability.
- Wrap all mutating tools with idempotent mutation helpers.
- Use locking for shared mutable entities.
- Persist pack events/metrics/validations for continuity.

## Creating a New Pack

1. Create `src/domain-packs/<pack-id>.ts`.
2. Export a `DomainPack` object.
3. Add it to `BUILTIN_DOMAIN_PACKS` in `src/domain-packs/index.ts`.
4. Add tests under `tests/<pack-id>_pack.integration.test.mjs`.
5. Document tool contracts in `docs/`.

## Minimal Pack Checklist

- At least one read tool and one mutating tool.
- Mutating tools require `mutation.idempotency_key` and `mutation.side_effect_fingerprint`.
- Pack data persists locally in SQLite.
- Pack emits enough metadata for reconstruction/reporting.

## Suggested Universal Patterns

- `*.entity.create`
- `*.entity.get`
- `*.entity.list`
- `*.workflow.start`
- `*.workflow.status`
- `*.workflow.stop`
- `*.validation.check`
- `*.report.bundle`

## Testing Expectations

A pack should include:

- registration test (tool appears only when pack enabled)
- happy-path lifecycle test
- failure-path test for missing required entities
- idempotency replay test for at least one mutating tool
