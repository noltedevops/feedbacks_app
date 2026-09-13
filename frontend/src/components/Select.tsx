import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useIsMobile } from '../useIsMobile';

/**
 * The app's dropdown.
 *
 * On a desktop or tablet: a menu - a soft raised panel that eases in under the
 * control, options grouped under overline headers, an optional second line under an
 * option (a project's name under its id), a tick on the current value. Keyboard
 * complete: arrows, Home/End, Enter/Space, Escape, Tab, and type-ahead.
 *
 * On a phone: the native <select>. The OS picker is faster with a thumb, works with
 * gloves, and is what the crew already knows - the one place the platform's own
 * control beats anything drawn here.
 */

export interface SelectOption {
  value: string;
  label: string;
  /** A second, quieter line under the label. */
  description?: string;
  /** Options sharing a group are listed under one overline header, in order. */
  group?: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** The control's accessible name. Required: several call sites have no visible label. */
  ariaLabel: string;
  className?: string;
  /** A leading glyph inside the control (search, VM number, instrument). */
  icon?: React.ReactNode;
  size?: 'md' | 'sm';
  id?: string;
  disabled?: boolean;
  title?: string;
}

// How far the panel may run before it flips above the control instead.
const PANEL_MAX_H = 320;
const GAP = 4;

export function Select({ value, onChange, options, ariaLabel, className, icon, size = 'md', id, disabled, title }: SelectProps) {
  const isMobile = useIsMobile();
  const selected = options.find(o => o.value === value);

  // Phones: the OS picker, grouped the same way.
  if (isMobile) {
    const groups = groupOptions(options);
    return (
      <select
        id={id}
        className={`form-input ${className ?? ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        title={title ?? selected?.label}
        disabled={disabled}
      >
        {groups.map(([group, opts]) => group
          ? <optgroup key={group} label={group}>{opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup>
          : opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    );
  }

  return (
    <MenuSelect
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel={ariaLabel}
      className={className}
      icon={icon}
      size={size}
      id={id}
      disabled={disabled}
      title={title}
      selected={selected}
    />
  );
}

/** Options in display order, bucketed by group (ungrouped first). */
function groupOptions(options: SelectOption[]): [string | undefined, SelectOption[]][] {
  const out: [string | undefined, SelectOption[]][] = [];
  for (const o of options) {
    const last = out[out.length - 1];
    if (last && last[0] === o.group) last[1].push(o);
    else out.push([o.group, [o]]);
  }
  return out;
}

function MenuSelect({ value, onChange, options, ariaLabel, className, icon, size, id, disabled, title, selected }: SelectProps & { selected?: SelectOption }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number; maxHeight: number; above: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const groups = useMemo(() => groupOptions(options), [options]);
  const indexOf = useMemo(() => new Map(options.map((o, i) => [o.value, i])), [options]);

  // Place the panel under the control - or above it, when there is more room there.
  // Fixed to the viewport and portalled to the body, so no panel with overflow:hidden
  // (the dashboard's, the report dialog's) can clip it.
  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - 8;
    const aboveRoom = r.top - GAP - 8;
    const above = below < Math.min(PANEL_MAX_H, 200) && aboveRoom > below;
    const maxHeight = Math.min(PANEL_MAX_H, above ? aboveRoom : below);
    setPos({
      top: above ? r.top - GAP : r.bottom + GAP,
      left: Math.min(r.left, window.innerWidth - Math.max(r.width, 200) - 8),
      minWidth: r.width,
      maxHeight,
      above
    });
  }, []);

  const openMenu = useCallback((startAt?: number) => {
    if (disabled) return;
    const current = options.findIndex(o => o.value === value);
    setActive(startAt ?? (current >= 0 ? current : 0));
    // A control scrolled half out of its panel (the form scrolls inside the sidebar)
    // comes fully into view first, so the menu is placed against where it really is.
    triggerRef.current?.scrollIntoView({ block: 'nearest' });
    place();
    setOpen(true);
  }, [disabled, options, value, place]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const choose = useCallback((i: number) => {
    const o = options[i];
    if (!o) return;
    if (o.value !== value) onChange(o.value);
    close();
  }, [options, value, onChange, close]);

  // While open: follow the control as the page or a panel scrolls, and close on a
  // press anywhere outside the control and the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      close(false);
    };
    const onMove = () => place();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, close, place]);

  // Focus moves into the list when it opens, and the active option stays in view.
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    // optionId is stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  // Type-ahead: letters typed within half a second build one prefix.
  const jumpTo = (key: string) => {
    const now = Date.now();
    const t = typeahead.current;
    t.text = now - t.at > 500 ? key : t.text + key;
    t.at = now;
    const needle = t.text.toLowerCase();
    const from = t.text.length === 1 ? active + 1 : active;
    const order = [...options.keys()].map(k => (k + Math.max(0, from)) % options.length);
    const hit = order.find(k => options[k].label.toLowerCase().startsWith(needle));
    if (hit !== undefined) setActive(hit);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      const current = options.findIndex(o => o.value === value);
      openMenu(e.key === 'ArrowUp' ? Math.max(0, current - 1) : undefined);
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive(i => Math.min(options.length - 1, i + 1)); break;
      case 'ArrowUp': e.preventDefault(); setActive(i => Math.max(0, i - 1)); break;
      case 'Home': e.preventDefault(); setActive(0); break;
      case 'End': e.preventDefault(); setActive(options.length - 1); break;
      case 'Enter':
      case ' ': e.preventDefault(); choose(active); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break;
      case 'Tab': close(false); break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) jumpTo(e.key);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`sel${size === 'sm' ? ' sel--sm' : ''} ${className ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${ariaLabel}: ${selected?.label ?? ''}`}
        title={title ?? selected?.label}
        disabled={disabled}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {icon && <span className="sel-icon" aria-hidden="true">{icon}</span>}
        <span className="sel-value">{selected?.label ?? ''}</span>
        <ChevronDown size={16} className="sel-chevron" aria-hidden="true" />
      </button>

      {open && pos && createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={active >= 0 ? optionId(active) : undefined}
          tabIndex={-1}
          className={`sel-panel${pos.above ? ' sel-panel--above' : ''}`}
          // Computed placement - the one thing a stylesheet cannot know.
          style={{
            top: pos.above ? undefined : pos.top,
            bottom: pos.above ? window.innerHeight - pos.top : undefined,
            left: pos.left,
            minWidth: pos.minWidth,
            maxHeight: pos.maxHeight
          }}
          onKeyDown={onListKey}
        >
          {groups.map(([group, opts], gi) => (
            <React.Fragment key={group ?? `g${gi}`}>
              {group && <li role="presentation" className="sel-group">{group}</li>}
              {opts.map((o) => {
                const i = indexOf.get(o.value) ?? 0;
                const isSelected = o.value === value;
                return (
                  <li
                    key={o.value}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isSelected}
                    data-active={i === active ? '' : undefined}
                    className="sel-option"
                    onMouseEnter={() => setActive(i)}
                    // mousedown, not click: keep focus in the list until the choice lands.
                    onMouseDown={(e) => { e.preventDefault(); choose(i); }}
                  >
                    <span className="sel-option-text">
                      <span className="sel-option-label">{o.label}</span>
                      {o.description && <span className="sel-option-desc">{o.description}</span>}
                    </span>
                    {isSelected && <Check size={16} className="sel-option-check" aria-hidden="true" />}
                  </li>
                );
              })}
            </React.Fragment>
          ))}
        </ul>,
        document.body
      )}
    </>
  );
}
