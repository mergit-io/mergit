import { getAddress, isAddress, type Address } from "viem";

export type Mirror = {
  /** The Base block the counts were read at. */
  asOfBlock: number;
  auditedStaked: number;
  verifiedStaked: number;
  byCategory: { category: string; auditedStaked: number; verifiedStaked: number }[];
  note: string;
};

const MAX_RECORD_CHARS = 20_000;
const MAX_CATEGORIES = 100;
const MAX_CATEGORY_CHARS = 80;
const MAX_NOTE_CHARS = 500;

const own = (o: object, key: string): unknown =>
  Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;
const isObject = (v: unknown): v is object => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function counts(o: unknown, where: string): { auditedStaked: number; verifiedStaked: number } {
  if (!isObject(o)) throw new Error(`The reputation record's ${where} is not an object.`);
  const audited = own(o, "auditedStaked");
  const verified = own(o, "verifiedStaked");
  if (!isCount(audited) || !isCount(verified))
    throw new Error(`The reputation record's ${where} counts are not whole numbers.`);
  if (verified > audited) throw new Error(`The reputation record's ${where} has more verified than audited outcomes.`);
  return { auditedStaked: audited, verifiedStaked: verified };
}

/**
 * Reads the `mergit.reputation` text record (HLD 6.3), written by the publisher. It is an on-chain mirror, not a score.
 * Everything is checked and anything odd throws: a record that is not exactly what the publisher writes, or that names a
 * different chain or contract as its source, is never shown. `expected` is the Base ReputationAnchor this app trusts.
 */
export function parseMirror(raw: string, expected: { chainId: number; contract: Address }): Mirror {
  if (typeof raw !== "string") throw new Error("The reputation record is not text.");
  if (raw.length > MAX_RECORD_CHARS)
    throw new Error("The reputation record is too large to be one the publisher wrote.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("The reputation record is not JSON.");
  }
  if (!isObject(body)) throw new Error("The reputation record is not a JSON object.");
  if (own(body, "v") !== 0) throw new Error("The reputation record has an unknown version.");
  if (own(body, "mirror") !== true) throw new Error("The reputation record does not say it is a mirror.");

  const source = own(body, "source");
  const contract = isObject(source) ? own(source, "contract") : undefined;
  if (
    !isObject(source) ||
    own(source, "chainId") !== expected.chainId ||
    typeof contract !== "string" ||
    contract.toLowerCase() !== expected.contract.toLowerCase()
  ) {
    throw new Error("The reputation record names a different source than the ReputationAnchor this app trusts.");
  }

  const asOfBlock = own(body, "asOfBlock");
  if (!isCount(asOfBlock)) throw new Error("The reputation record's block is not a whole number.");
  const totals = counts(body, "totals");

  const categories = own(body, "byCategory");
  if (!isObject(categories)) throw new Error("The reputation record's categories are missing.");
  const keys = Object.keys(categories);
  if (keys.length > MAX_CATEGORIES) throw new Error("The reputation record has too many categories.");
  const byCategory: Mirror["byCategory"] = [];
  let audited = 0;
  let verified = 0;
  for (const category of keys) {
    if (category.length === 0 || category.length > MAX_CATEGORY_CHARS)
      throw new Error("The reputation record has a category with a bad name.");
    const c = counts(own(categories, category), `category ${category}`);
    byCategory.push({ category, ...c });
    audited += c.auditedStaked;
    verified += c.verifiedStaked;
  }
  if (audited !== totals.auditedStaked || verified !== totals.verifiedStaked) {
    throw new Error("The reputation record's categories do not add up to its totals.");
  }
  byCategory.sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));

  const note = own(body, "note");
  return { asOfBlock, ...totals, byCategory, note: typeof note === "string" ? note.slice(0, MAX_NOTE_CHARS) : "" };
}

/** The `mergit.operator` record: a checksummed address, or null if the record is empty or not an address. */
export function parseOperator(raw: string): Address | null {
  return typeof raw === "string" && isAddress(raw, { strict: false }) ? getAddress(raw) : null;
}
