import { useTheme } from "../theme/context";
import { Icon } from "./Icon";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="iconbtn theme-toggle"
      data-theme-state={theme}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        toggle({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }}
    >
      <Icon name="sun" size={16} className="tt-sun" />
      <Icon name="moon" size={16} className="tt-moon" />
    </button>
  );
}
