import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Where World's callback sends the popup once the human has answered (plan sec 1.7): `{public_origin}
 * /world/approved?approval=<id>&status=<status>`. Its only job is to read that back off the query string,
 * tell the window that opened it, then close. A bare top-level route, not nested under the signed-in app
 * shell: the popup may never have a session established the way the main tab does, so this must render
 * with no sign-in gate.
 *
 * If there is no `window.opener` -- the popup already lost it, or someone opened this link directly -- there
 * is nothing to post to, so it just tells the human the window can be closed, and never throws.
 */
export function WorldApproved() {
  const [params] = useSearchParams();

  useEffect(() => {
    const approvalId = params.get("approval");
    const status = params.get("status");
    // `Window.opener` is typed `any` in the DOM lib; it is still just a `Window` when set.
    const opener = window.opener as Window | null;
    if (approvalId && status && opener) {
      opener.postMessage({ type: "mergit-world-approval", approval_id: approvalId, status }, window.location.origin);
      window.close();
    }
  }, [params]);

  return (
    <main className="col g12 pad24" style={{ maxWidth: 420, margin: "0 auto" }}>
      <p className="small c2" role="status">
        You can close this window.
      </p>
    </main>
  );
}
