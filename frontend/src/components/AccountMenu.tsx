import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../auth/context";
import { me } from "../mock/data";
import { Icon } from "./Icon";

/** Avatar button with the signed-in address and Sign out. */
export function AccountMenu() {
  const { session, signOut } = useAuth();
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
        aria-label={`Account, signed in as ${me.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        {me.initials}
      </button>
      {open && (
        <div id={menuId} className="account-menu page-enter" role="menu">
          <div className="account-who">
            <span className="strong">{me.name}</span>
            <span className="mono-s c3">{session?.addressShort ?? me.address}</span>
          </div>
          <button type="button" role="menuitem" className="account-item" onClick={signOut}>
            <Icon name="external" size={14} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
