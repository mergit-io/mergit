import { howItWorks } from "../content";
import { LIcon } from "../LIcon";
import { useInView, useStepper, useTypewriter } from "../motion";
import { SectionHead } from "./SectionHead";

const STEP_MS = 650;

function StepChip({ text, active }: { text: string; active: boolean }) {
  const [shown, done] = useTypewriter(text, active, 26);
  return (
    <div className="how-chip" aria-label={text}>
      <span aria-hidden="true">
        {shown}
        {active && !done && <i className="caret" />}
      </span>
    </div>
  );
}

export function HowItWorks() {
  const [ref, inView] = useInView<HTMLElement>();
  const lit = useStepper(howItWorks.steps.length, inView, STEP_MS, 450);

  return (
    <section
      id="how-it-works"
      ref={ref}
      className={`l-section l-white${inView ? " in" : ""}`}
      aria-labelledby="how-title"
    >
      <div className="l-container">
        <SectionHead id="how-title" eyebrow={howItWorks.eyebrow} title={howItWorks.title} lede={howItWorks.lede} />
        <ol className="how-steps">
          {howItWorks.steps.map((step, i) => (
            <li
              key={step.title}
              className={`how-step l-reveal${lit > i ? " lit" : ""}`}
              style={{ transitionDelay: `${String(250 + i * 90)}ms` }}
            >
              <div className="how-top">
                <span className="how-num">{String(i + 1).padStart(2, "0")}</span>
                <LIcon name={step.icon} size={26} />
              </div>
              <div className="how-line">
                <i />
              </div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <StepChip text={step.chip} active={lit > i} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
