/** A 53-bit string hash (cyrb53): not a secret, only a short fingerprint of what was typed. */
function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The Idempotency-Key for drafting a plan from this form. `nonce` is one random value per page load, so the same
 * form sent twice in a row (a retry, a double click) names the same plan, an edited form names a new one, and a
 * form submitted again in a later visit is not mistaken for an old plan.
 */
export function planKey(nonce: string, form: Record<string, string>): string {
  return `${nonce}.${fingerprint(JSON.stringify(Object.entries(form).sort()))}`;
}
