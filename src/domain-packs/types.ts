import { z } from "zod";
import { Storage } from "../storage.js";
import { runIdempotentMutation } from "../tools/mutation.js";

export type PackToolHandler = (input: any) => Promise<unknown> | unknown;

export type PackToolRegistrar = (
  name: string,
  description: string,
  schema: z.ZodTypeAny,
  handler: PackToolHandler
) => void;

export type DomainPackContext = {
  storage: Storage;
  repo_root: string;
  server_name: string;
  server_version: string;
  register_tool: PackToolRegistrar;
  run_idempotent_mutation: typeof runIdempotentMutation;
};

export type DomainPack = {
  id: string;
  title: string;
  description: string;
  register: (context: DomainPackContext) => void;
};

export type DomainPackRegistrationResult = {
  requested: string[];
  registered: string[];
  unknown: string[];
};
