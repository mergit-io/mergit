import { useRef, type KeyboardEvent } from "react";
import { useSlidingThumb } from "../hooks/useSlidingThumb";

const STEP: Partial<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * Pill segmented control with a sliding thumb. Follows the radio-group pattern:
 * one tab stop, arrow keys move the selection and focus.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const thumb = useSlidingThumb(ref, '[aria-checked="true"]', value);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = STEP[event.key];
    if (!step) return;
    event.preventDefault();
    const index = (options.indexOf(value) + step + options.length) % options.length;
    const next = options[index];
    if (next === undefined) return;
    onChange(next);
    // The buttons don't change, only which one is checked, so focus can move now.
    ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus();
  };

  return (
    <div ref={ref} className={`seg${className ? ` ${className}` : ""}`} role="radiogroup" aria-label={label}>
      {thumb && (
        <span
          className="thumb"
          data-thumb
          aria-hidden="true"
          style={{ width: thumb.w, transform: `translateX(${thumb.x}px)` }}
        />
      )}
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === value}
          tabIndex={option === value ? 0 : -1}
          className={option === value ? "on" : undefined}
          onClick={() => {
            onChange(option);
          }}
          onKeyDown={onKeyDown}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
