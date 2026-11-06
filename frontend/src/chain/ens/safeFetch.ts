const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 100 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type SafeFetchOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** What is being fetched, as the subject of the error messages. */
  what?: string;
};

function httpsUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname !== "" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Fetches text from a URL that came from the chain (an agent's metadata URI, a ledger snapshot), so the URL is untrusted:
 * https only, no credentials, no referrer, a time limit, a size limit (2 MB unless given), and a redirect must not leave
 * https. Returns the body exactly as sent (a byte-order mark is kept, so a hash of it is a hash of the file). Rejects with
 * a plain message.
 */
export async function fetchTextSafely(url: string, options: SafeFetchOptions = {}): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TEXT_BYTES;
  const what = options.what ?? "The file";
  if (!httpsUrl(url)) throw new Error(`${what} is not at an https URL.`);

  const controller = new AbortController();
  const state = { timedOut: false }; // an object, so the closure assignment is not narrowed away
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await doFetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
    } catch (cause) {
      throw new Error(state.timedOut ? `${what} took too long to load.` : `${what} could not be fetched.`, { cause });
    }
    if (response.url !== "" && !httpsUrl(response.url)) throw new Error(`${what} redirected away from https.`);
    if (!response.ok) throw new Error(`${what} could not be fetched (${String(response.status)}).`);
    const announced = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(announced) && announced > maxBytes) throw new Error(`${what} is too large.`);

    try {
      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        if (text.length > maxBytes) throw new Error("too large");
        return text;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error("too large");
        }
        chunks.push(value);
      }
      return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
    } catch (cause) {
      if (cause instanceof Error && cause.message === "too large") throw new Error(`${what} is too large.`, { cause });
      throw new Error(state.timedOut ? `${what} took too long to load.` : `${what} could not be read.`, { cause });
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches and parses JSON with the guards of `fetchTextSafely`, but a 100 KB limit unless given (a registration file). */
export async function fetchJsonSafely(url: string, options: SafeFetchOptions = {}): Promise<unknown> {
  const what = options.what ?? "The registration file";
  const text = await fetchTextSafely(url, { ...options, what, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES });
  try {
    return JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch (cause) {
    throw new Error(`${what} is not valid JSON.`, { cause });
  }
}
