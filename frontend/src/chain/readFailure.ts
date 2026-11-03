/**
 * What to say when a read from the chain failed. If the browser itself is offline the chain was never the problem,
 * so say that instead of blaming it (`what` is what could not be read, `where` the network it lives on).
 */
export function readFailure(what: string, where: string): string {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return "You appear to be offline. Reconnect and try again.";
  }
  return `Could not read ${what} from ${where}. Try again in a moment.`;
}
