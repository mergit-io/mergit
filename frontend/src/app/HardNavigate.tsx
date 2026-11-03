import { useEffect } from "react";

/**
 * Loads the current address again from the server. The demo and the real app are the same bundle in different modes,
 * and the mode is decided from the address the page was loaded at, so a client-side jump from one to the other would
 * leave the wrong mode running. Rendering this at a route that belongs to the other side makes the jump a full page
 * load, which starts the right mode with none of the other side's state.
 */
export function HardNavigate() {
  useEffect(() => {
    window.location.replace(window.location.href);
  }, []);
  return null;
}
