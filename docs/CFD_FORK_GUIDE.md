# CFD Fork Guide

This guide explains how to publish a dedicated CFD MCP server fork from the core template.

## Forking Strategy

- Core repo: universal runtime + optional packs.
- CFD fork repo: same runtime, but default docs/config centered on `cfd` pack.

## Step 1: Create Fork Repository

Example:

```bash
git clone https://github.com/driverd12/MCPlayground---Core-Template.git MCPlayground---CFD-Server
cd MCPlayground---CFD-Server
```

## Step 2: Enable CFD by Default

In `.env`:

```bash
MCP_DOMAIN_PACKS=cfd
```

Optional startup alias in `package.json`:

- keep `start:cfd` as default team command.

## Step 3: CFD-Focused Documentation

Update the fork README to emphasize:

- CFD lifecycle tools (`cfd.*`)
- expected solver integrations
- validation/convergence policy
- report and ADR process

## Step 4: Add Solver Adapter Commands

Implement local wrappers for your preferred solver stack:

- OpenFOAM workflows
- Fluent/CFX wrappers
- custom post-processing scripts

Use `task.*` and `run.*` to orchestrate long-running solves.

## Step 5: Governance and Quality Gates

Require in team workflow:

- mesh checks (`cfd.mesh.check`)
- result comparison (`cfd.validate.compare`)
- ADR entry for major solver/model changes

## Step 6: Publish

```bash
git remote set-url origin <your-cfd-repo-url>
git push -u origin main
```

## Optional: Keep Core Upstream Linked

```bash
git remote add upstream https://github.com/driverd12/MCPlayground---Core-Template.git
git fetch upstream
```

Then periodically rebase/merge from upstream.

## CFD Pack Tool Inventory

- `cfd.case.create`
- `cfd.case.get`
- `cfd.case.list`
- `cfd.mesh.generate`
- `cfd.mesh.check`
- `cfd.solve.start`
- `cfd.solve.status`
- `cfd.solve.stop`
- `cfd.post.extract`
- `cfd.validate.compare`
- `cfd.report.bundle`
- `cfd.schema.status`
