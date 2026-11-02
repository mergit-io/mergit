import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { paths } from "../app/paths";
import { useAuth } from "../auth/context";
import { useIdentity } from "../auth/useIdentity";
import { DATA_MODE } from "../config/live";
import { Icon } from "./Icon";

/** Avatar button with the signed-in address and Sign out. */
export function AccountMenu() {
  const { signOut } = useAuth();
  const identity = useIdentity();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="account" ref={rootRef}>
      <button
        type="button"
        className="avatarme"
        aria-label={`Account, signed in as ${identity.name ?? identity.addressShort}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        {identity.initials}
      </button>
      {open && (
        <div id={menuId} className="account-menu page-enter" role="menu">
          <div className="account-who">
            <span className="strong">{identity.name ?? (identity.trial ? "Free trial" : "Your wallet")}</span>
            <span className="mono-s c3">{identity.detail || identity.addressShort}</span>
            {identity.address && identity.detail !== identity.address && (
              <span className="mono-s c3">{identity.address}</span>
            )}
          </div>
          {DATA_MODE === "live" && (
            <Link
              to={paths.settings}
              role="menuitem"
              className="account-item"
              onClick={() => {
                setOpen(false);
              }}
            >
              <Icon name="shield" size={14} />
              Settings
            </Link>
          )}
          <button type="button" role="menuitem" className="account-item" onClick={signOut}>
            <Icon name="external" size={14} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
