import { paths } from "../app/paths";
import { Button } from "../components/Button";

export function NotFound() {
  return (
    <div className="col g12 not-found">
      <span className="mono c3">404</span>
      <h1 className="display">Nothing settled here</h1>
      <p className="c2">This page does not exist yet.</p>
      <Button variant="primary" to={paths.app}>
        Back to overview
      </Button>
    </div>
  );
}
