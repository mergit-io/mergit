import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getSuggestions } from "./client";
import type { SuggestionsResponse } from "./types";

/**
 * The control plane's suggested agents for each task of a draft: advice next to the manual picks, never a
 * replacement for them. The ranking (`explore=false`, a plain read) loads on mount and again whenever
 * `saved` changes (pass something that changes when the saved tasks do, e.g. their budgets). A random draw
 * (`explore=true`) is recorded and rate-limited server-side, so it is only fetched when the requester asks
 * for one through `setExplore(true)`; nothing here draws on its own.
 *
 * A failure only sets `error`: the suggestions shown before it stay, and the caller keeps manual picking.
 */
export function useSuggestions(planUuid: string, saved: string) {
  const [suggestions, setSuggestions] = useState<SuggestionsResponse | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  // Only the latest call's answer lands, so a slow ranking can't overwrite a draw asked for after it.
  const latest = useRef(0);

  const load = useCallback(
    (explore: boolean) => {
      const call = ++latest.current;
      let cancelled = false;
      const current = () => !cancelled && call === latest.current;
      getSuggestions(planUuid, explore).then(
        (answer) => {
          if (!current()) return;
          // Anything without a task list is not the suggestions service answering.
          if (Array.isArray((answer as Partial<SuggestionsResponse> | null)?.tasks)) {
            setSuggestions(answer);
            setError(undefined);
          } else {
            setError("Mergit's API did not answer like the suggestions service.");
          }
          setLoading(false);
        },
        (e: unknown) => {
          if (!current()) return;
          setError(errorMessage(e));
          setLoading(false);
        },
      );
      return () => {
        cancelled = true;
      };
    },
    [planUuid],
  );

  // `saved` is a dependency on purpose: the ranking is read again when the saved tasks change.
  useEffect(() => load(false), [load, saved]);

  const setExplore = useCallback(
    (explore: boolean) => {
      if (loading) return; // one request at a time: a double click must not record two draws
      setLoading(true);
      load(explore);
    },
    [load, loading],
  );

  return { suggestions, error, loading, setExplore };
}
