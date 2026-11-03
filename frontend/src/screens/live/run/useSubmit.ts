import { useCallback, useRef, useState } from "react";
import { ApiError, errorMessage } from "../../../api/client";
import { runOnce } from "./singleFlight";

/**
 * One form action at a time: `busy` while it runs, and every problem it ended with. API errors carry
 * all of the API's reasons; anything else becomes one line. A second call while one is running is ignored (a double
 * click can land before the button re-renders as disabled), so one click is one request.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const running = useRef(false);

  const submit = useCallback(
    (action: () => Promise<void>) =>
      runOnce(running, async () => {
        setBusy(true);
        setProblems([]);
        try {
          await action();
        } catch (e) {
          setProblems(e instanceof ApiError ? e.problems : [errorMessage(e)]);
        } finally {
          setBusy(false);
        }
      }),
    [],
  );

  return { busy, problems, setProblems, submit };
}
