export type RegistrationInfo = {
  /** The name the file claims for the agent (its ENS service endpoint), or null if it names none. */
  ensName: string | null;
  /** The registry entries the file claims, `agentId` as a decimal string. Entries that cannot be read are left out. */
  registrations: { agentId: string; agentRegistry: string }[];
};

const own = (o: object, key: string): unknown =>
  Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;
const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads an ERC-8004 registration file fetched from an agent's metadata URI. The file is hostile input: only own
 * properties are read, every value is checked before it is used, and an entry that cannot be trusted is skipped, never
 * guessed at. Whether the file is the right one for the agent is decided by the caller (the two-way check).
 */
export function parseRegistrationFile(body: unknown): RegistrationInfo {
  if (!isObject(body)) throw new Error("The registration file is not a JSON object.");
  const services = own(body, "services");
  const registrations = own(body, "registrations");
  if (services !== undefined && !Array.isArray(services))
    throw new Error("The registration file's services are not a list.");
  if (registrations !== undefined && !Array.isArray(registrations))
    throw new Error("The registration file's registrations are not a list.");

  let ensName: string | null = null;
  const ens = (services ?? []).find((s: unknown) => {
    const name = isObject(s) ? own(s, "name") : undefined;
    return typeof name === "string" && name.toLowerCase() === "ens";
  }) as object | undefined;
  const endpoint = ens ? own(ens, "endpoint") : undefined;
  if (typeof endpoint === "string" && endpoint.length <= 253 && !/\s/.test(endpoint) && endpoint.length > 0)
    ensName = endpoint;

  const out: RegistrationInfo["registrations"] = [];
  for (const r of registrations ?? []) {
    if (!isObject(r)) continue;
    const id = own(r, "agentId");
    const registry = own(r, "agentRegistry");
    const agentId =
      typeof id === "number" && Number.isSafeInteger(id) && id >= 0
        ? String(id)
        : typeof id === "string" && /^[0-9]{1,30}$/.test(id)
          ? id
          : null;
    if (agentId !== null && typeof registry === "string") out.push({ agentId, agentRegistry: registry });
  }
  return { ensName, registrations: out };
}
