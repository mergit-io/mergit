import { useCallback } from "react";
import { useToast } from "../toast/context";

/** Handler for controls whose action lives in the backend, which does not exist yet. */
export function useNotWired() {
  const toast = useToast();
  return useCallback(() => {
    toast("Needs the backend, not wired up yet");
  }, [toast]);
}
