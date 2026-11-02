/**
 * Runs `action` unless one is already running on this flag. A second click can land before React has re-rendered the
 * button as disabled, so state alone does not stop it; a ref-like flag does. The flag is cleared however the action
 * ends.
 */
export async function runOnce(flag: { current: boolean }, action: () => Promise<void>): Promise<void> {
  if (flag.current) return;
  flag.current = true;
  try {
    await action();
  } finally {
    flag.current = false;
  }
}
