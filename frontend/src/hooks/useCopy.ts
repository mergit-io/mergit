import { useCallback } from "react";
import { useToast } from "../toast/context";

/** Copy text and confirm with a toast. The Clipboard API only exists in secure contexts. */
export function useCopy() {
  const toast = useToast();
  return useCallback(
    (text: string, label = "Copied") => {
      if (!window.isSecureContext) {
        toast("Copy needs HTTPS");
        return;
      }
      navigator.clipboard.writeText(text).then(
        () => {
          toast(label);
        },
        () => {
          toast("Copy failed");
        },
      );
    },
    [toast],
  );
}
