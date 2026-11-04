import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

interface PopoverState {
  openId: string | null;
  setOpenId: (id: string | null) => void;
}

const PopoverContext = createContext<PopoverState | null>(null);

/** Keeps at most one header popover open at a time. */
export function PopoverGroup({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return <PopoverContext value={{ openId, setOpenId }}>{children}</PopoverContext>;
}

interface PopoverProps {
  id: string;
  buttonClassName: string;
  /** Accessible name of the button, when its content doesn't say it all. */
  buttonLabel?: string;
  buttonTitle?: string;
  buttonContent: ReactNode;
  popoverClassName: string;
  /** `menu` for a list of menu items (arrow keys move between them). */
  role?: 'menu';
  /** Popover content; `close` closes it (and puts focus back on the button). */
  children: (close: () => void) => ReactNode;
}

/**
 * A button with a popover: opens on click, Enter or Space; closes on Esc (focus back to the
 * button), a click outside, or `close()` from a chosen item.
 */
export function Popover(props: PopoverProps) {
  const group = use(PopoverContext);
  if (!group) throw new Error('Popover used outside PopoverGroup');
  const { openId, setOpenId } = group;
  const open = openId === props.id;
  const wrap = useRef<HTMLDivElement>(null);
  const popoverId = `${props.id}-popover`;
  const buttonId = `${props.id}-button`;

  // Looked up by id rather than a ref: `close` is handed to the content while rendering.
  const close = useCallback(() => {
    setOpenId(null);
    document.getElementById(buttonId)?.focus();
  }, [setOpenId, buttonId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !wrap.current?.contains(event.target)) setOpenId(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, setOpenId]);

  // A menu puts focus on its checked (or first) item when it opens.
  useEffect(() => {
    if (!open || props.role !== 'menu') return;
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  }, [open, props.role]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (props.role !== 'menu') return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    const at = items.findIndex((item) => item === document.activeElement);
    const next =
      event.key === 'ArrowDown'
        ? (at + 1) % items.length
        : event.key === 'ArrowUp'
          ? (at - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className="pop-wrap" ref={wrap}>
      <button
        id={buttonId}
        type="button"
        className={props.buttonClassName}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-haspopup={props.role === 'menu' ? 'menu' : undefined}
        aria-label={props.buttonLabel}
        title={props.buttonTitle}
        onClick={() => {
          setOpenId(open ? null : props.id);
        }}
      >
        {props.buttonContent}
      </button>
      <div
        id={popoverId}
        className={`popover ${props.popoverClassName}`}
        role={props.role}
        aria-label={props.role === 'menu' ? props.buttonLabel : undefined}
        hidden={!open}
        onKeyDown={onMenuKeyDown}
      >
        {open && props.children(close)}
      </div>
    </div>
  );
}
