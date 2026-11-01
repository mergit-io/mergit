import type { ReactNode } from "react";
import "@fontsource/instrument-serif/latin-400.css";
import type { CSSProperties } from "react";
import { PLANS, type Plan, type PlanId } from "../pricing/plans";
import { Icon } from "./Icon";

/**
 * The three plans as cards. The caller supplies each card's action and anything under it (the wallet list), so the
 * dialog and the pricing page share the look while each keeps its own behaviour.
 */
export function PlanCards({ action, below }: { action: (plan: Plan) => ReactNode; below?: (plan: Plan) => ReactNode }) {
  return (
    <div className="plan-grid">
      {PLANS.map((plan, index) => (
        <section
          key={plan.id}
          className={`plan-card plan-${plan.id}${plan.soon ? " is-soon" : ""}${plan.featured ? " is-featured" : ""}`}
          style={{ "--i": index } as CSSProperties}
          aria-labelledby={`plan-${plan.id}-name`}
        >
          <div className="row g8 plan-top">
            <span className="plan-tag">{plan.tag}</span>
            {plan.soon && <span className="plan-soon">Soon</span>}
            {plan.featured && <span className="plan-ribbon">{plan.featured}</span>}
          </div>
          <h3 id={`plan-${plan.id}-name`} className="plan-name">
            {plan.name}
          </h3>
          <p className="small c2 plan-blurb">{plan.blurb}</p>
          <p className="plan-price">
            <span className="plan-amount">{plan.amount}</span>
            <span className="small c3">{plan.unit}</span>
          </p>
          <ul className="plan-list small c2">
            {plan.includes && (
              <li className="plan-includes">
                <Icon name="list" size={14} stroke={2.2} />
                {plan.includes}
              </li>
            )}
            {plan.features.map((feature) => (
              <li key={feature}>
                <Icon name="check" size={14} stroke={2.4} />
                {feature}
              </li>
            ))}
          </ul>
          {action(plan)}
          {below?.(plan)}
        </section>
      ))}
    </div>
  );
}

export type { PlanId };
