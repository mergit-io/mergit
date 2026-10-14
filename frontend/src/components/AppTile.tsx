import { Icon, type IconName } from "./Icon";

/** Rounded square app logo: an icon (e.g. the GitHub mark) or a two-letter monogram. */
export function AppTile({ mark, icon, size = 48 }: { mark?: string; icon?: IconName; size?: number }) {
  return (
    <span className={`tile${size >= 40 ? " tile-lg" : ""}`} style={{ width: size, height: size }}>
      {icon ? <Icon name={icon} size={Math.round(size / 2)} /> : <span style={{ fontSize: size / 3 }}>{mark}</span>}
    </span>
  );
}
