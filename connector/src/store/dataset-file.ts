import { readFile } from "node:fs/promises";
import type { RegistryDataset } from "./memory.js";

const DATASET_KEYS: (keyof RegistryDataset)[] = [
  "companies",
  "memberships",
  "plugins",
  "verification_reports",
  "releases",
  "handoffs",
];

export async function loadDataset(path: string): Promise<RegistryDataset> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Registry dataset at ${path} is not a JSON object`);
  }
  for (const key of DATASET_KEYS) {
    if (!Array.isArray((raw as Record<string, unknown>)[key])) {
      throw new Error(`Registry dataset at ${path} is missing array "${key}"`);
    }
  }
  return raw as RegistryDataset;
}

