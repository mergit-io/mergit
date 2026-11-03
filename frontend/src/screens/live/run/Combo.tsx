import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../../../components/Icon";

export type ComboOption = {
  id: string;
  label: string;
  /** A second line under the label. */
  detail?: string;
  /** A short tag on the right (a language, "default"). */
  meta?: string;
};

/**
 * A text field with a list of suggestions under it (the ARIA combobox pattern): type freely, or pick with the mouse or
 * the arrow keys and Enter. The parent filters `options`; `note` is a line under the list (loading, an error, a hint).
 */
export function Combo({
  label,
  icon,
  value,
  onChange,
  onPick,
  options,
  note,
  placeholder,
  className,
}: {
  label: string;
  icon: IconName;
  value: string;
  onChange: (value: string) => void;
  onPick: (option: ComboOption) => void;
  options: ComboOption[];
  note?: ReactNode;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const shown = open && (options.length > 0 || Boolean(note));
  const optionId = (i: number) => `${id}-o${String(i)}`;

  const pick = (option: ComboOption) => {
    onPick(option);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (options.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + options.length) % options.length);
    } else if (e.key === "Enter" && shown && active >= 0) {
      const option = options[active];
      if (option) {
        e.preventDefault();
        pick(option);
      }
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div className={`nr-combo${shown ? " open" : ""}${className ? ` ${className}` : ""}`}>
      {/* A label, so a click anywhere on the pill focuses the field. */}
      <label className="nr-pill">
        <Icon name={icon} size={16} />
        <input
          role="combobox"
          aria-label={label}
          aria-expanded={shown}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onFocus={() => {
            setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
        />
        <Icon name="chevronDown" size={14} className="nr-chev" />
      </label>
      <div className="nr-pop" hidden={!shown}>
        <ul id={`${id}-list`} role="listbox" aria-label="Suggestions">
          {options.map((o, i) => (
            // The keyboard is handled by the field (arrows, Enter, Escape), as the combobox pattern has it.
            // eslint-disable-next-line jsx-a11y-x/click-events-have-key-events
            <li
              key={o.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={i === active ? "on" : undefined}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the field until the pick lands
              }}
              onMouseEnter={() => {
                setActive(i);
              }}
              onClick={() => {
                pick(o);
              }}
            >
              <span className="col min0 grow">
                <span className="mono ellipsis">{o.label}</span>
                {o.detail && <span className="small c3 ellipsis">{o.detail}</span>}
              </span>
              {o.meta && <span className="mono-s c3">{o.meta}</span>}
            </li>
          ))}
        </ul>
        {note && <div className="nr-note small c3">{note}</div>}
      </div>
    </div>
  );
}
