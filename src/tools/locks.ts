import { z } from "zod";
import { Storage } from "../storage.js";
import { mutationSchema } from "./mutation.js";

export const lockAcquireSchema = z.object({
  mutation: mutationSchema,
  lock_key: z.string().min(1),
  owner_id: z.string().min(1),
  lease_seconds: z.number().int().min(15).max(3600).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const lockReleaseSchema = z.object({
  mutation: mutationSchema,
  lock_key: z.string().min(1),
  owner_id: z.string().min(1),
  force: z.boolean().optional(),
});

export async function acquireLock(storage: Storage, input: z.infer<typeof lockAcquireSchema>) {
  const leaseSeconds = input.lease_seconds ?? 300;
  return storage.acquireLock({
    lock_key: input.lock_key,
    owner_id: input.owner_id,
    lease_seconds: leaseSeconds,
    metadata: input.metadata,
  });
}

export async function releaseLock(storage: Storage, input: z.infer<typeof lockReleaseSchema>) {
  return storage.releaseLock({
    lock_key: input.lock_key,
    owner_id: input.owner_id,
    force: input.force,
  });
}
