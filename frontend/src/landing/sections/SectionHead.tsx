import type { ReactNode } from "react";

/** Eyebrow, title and lede, blurring in when the section enters view. */
export function SectionHead({
  eyebrow,
  title,
  lede,
  split,
  id,
}: {
  eyebrow: string;
  title: ReactNode;
  lede: ReactNode;
  /** Title left, lede right, as in the team and proof sections. */
  split?: boolean;
  id: string;
}) {
  return (
    <div className={`l-head${split ? " split" : ""}`}>
      <div>
        <span className="l-eyebrow l-reveal">{eyebrow}</span>
        <h2 id={id} className="l-h2 l-reveal" style={{ transitionDelay: "80ms" }}>
          {title}
        </h2>
      </div>
      <p className="l-lede l-reveal" style={{ transitionDelay: "180ms" }}>
        {lede}
      </p>
    </div>
  );
}
