import { describe, expect, it } from "vitest";
import { runOnce } from "./singleFlight";

describe("runOnce", () => {
  it("runs an action once however many times it is asked while it is running", async () => {
    const flag = { current: false };
    let runs = 0;
    let release: () => void = () => undefined;
    const action = () => {
      runs += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    // Three clicks land before React has re-rendered the button as disabled.
    const first = runOnce(flag, action);
    const second = runOnce(flag, action);
    const third = runOnce(flag, action);
    expect(runs).toBe(1);
    release();
    await Promise.all([first, second, third]);
    expect(runs).toBe(1);
  });

  it("runs again once the first has finished, even when it failed", async () => {
    const flag = { current: false };
    let runs = 0;
    await runOnce(flag, () => {
      runs += 1;
      return Promise.reject(new Error("no"));
    }).catch(() => undefined);
    await runOnce(flag, () => {
      runs += 1;
      return Promise.resolve();
    });
    expect(runs).toBe(2);
    expect(flag.current).toBe(false);
  });
});
