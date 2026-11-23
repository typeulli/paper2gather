/**
 * Elements inside a node view marked with `data-node-ui` (editing panels, caption fields)
 * get their events handled by React only; ProseMirror ignores them.
 */
export function stopEventInNodeUi({ event }: { event: Event }): boolean {
  const target = event.target;
  return target instanceof Element && target.closest("[data-node-ui]") !== null;
}

export function booleanAttribute(name: string, defaultValue: boolean) {
  return {
    default: defaultValue,
    parseHTML: (el: HTMLElement) => {
      const v = el.getAttribute(`data-${name}`);
      return v === null ? defaultValue : v !== "false";
    },
    renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${name}`]: attrs[name] ? "true" : "false" }),
  };
}

export function stringAttribute(name: string, defaultValue: string | null = null) {
  return {
    default: defaultValue,
    parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) ?? defaultValue,
    renderHTML: (attrs: Record<string, unknown>) =>
      attrs[name] === null || attrs[name] === undefined ? {} : { [`data-${name}`]: String(attrs[name]) },
  };
}

/** A positive number; with `allowZero`, 0 is a value too. */
export function numberAttribute(name: string, defaultValue: number, allowZero = false) {
  return {
    default: defaultValue,
    parseHTML: (el: HTMLElement) => {
      const raw = el.getAttribute(`data-${name}`);
      const v = Number(raw);
      return raw !== null && Number.isFinite(v) && (v > 0 || (allowZero && v === 0)) ? v : defaultValue;
    },
    renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${name}`]: String(attrs[name]) }),
  };
}

export const LABEL_PATTERN = /^[a-zA-Z0-9:_\-.]*$/;
