const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 100 * 1024;

export type SafeFetchOptions = { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number };

function httpsUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname !== "" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Fetches JSON from a URL that came from the chain (an agent's metadata URI), so the URL is untrusted: https only, no
 * credentials, no referrer, a time limit, a size limit, and a redirect must not leave https. Rejects with a plain message.
 */
export async function fetchJsonSafely(url: string, options: SafeFetchOptions = {}): Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!httpsUrl(url)) throw new Error("The registration file is not at an https URL.");

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
      throw new Error(
        state.timedOut ? "The registration file took too long to load." : "The registration file could not be fetched.",
        { cause },
      );
    }
    if (response.url !== "" && !httpsUrl(response.url))
      throw new Error("The registration file redirected away from https.");
    if (!response.ok) throw new Error(`The registration file could not be fetched (${String(response.status)}).`);
    const announced = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(announced) && announced > maxBytes) throw new Error("The registration file is too large.");

    let text: string;
    try {
      const reader = response.body?.getReader();
      if (reader) {
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
        text = new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
      } else {
        text = await response.text();
        if (text.length > maxBytes) throw new Error("too large");
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message === "too large") {
        throw new Error("The registration file is too large.", { cause });
      }
      throw new Error(
        state.timedOut ? "The registration file took too long to load." : "The registration file could not be read.",
        { cause },
      );
    }
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new Error("The registration file is not valid JSON.", { cause });
    }
  } finally {
    clearTimeout(timer);
  }
}
