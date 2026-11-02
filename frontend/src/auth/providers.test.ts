import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The API address comes from the build's environment, which unit tests do not have.
vi.mock("../chain/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chain/wallet")>()),
  apiBase: () => "https://api.test",
}));

import { fetchProviders, resetProvidersCache } from "./accountApi";

const answer = (status: number, body: unknown = {}) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("fetchProviders", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resetProvidersCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the server once however many sign-in surfaces mount (the Connect window, /signin, Settings, New run)", async () => {
    fetchMock.mockImplementation(() => answer(200, { github: true, google: false, email: true }));
    const [a, b, c] = await Promise.all([fetchProviders(), fetchProviders(), fetchProviders()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ wallet: true, github: true, google: false, email: true });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    await fetchProviders(); // a later mount too
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failure: the next surface that mounts asks again", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await fetchProviders()).toBeNull();
    fetchMock.mockImplementationOnce(() => answer(503));
    expect(await fetchProviders()).toBeNull();
    fetchMock.mockImplementationOnce(() => answer(200, { github: true }));
    expect(await fetchProviders()).toMatchObject({ github: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
