// Anywidget COG selector.
//
// Renders a <select> dropdown of COG URLs and broadcasts the chosen URL on a
// window CustomEvent. The COG viewer widget subscribes to that event and
// reloads its map. MyST anywidgets have isolated models — no direct
// model-to-model linkage exists — so a window event bus is the simplest way
// to wire two directives together.
//
// Params (from the directive JSON body):
//   urls    : Array<string | {label, url}>  required.
//   event   : string                         default "cog-url-change".
//   label   : string                         default "COG:".
//   initial : number | string | null         default 0 (first option). Set to
//             null to skip the initial broadcast and require user interaction
//             before any viewer loads a COG.

function normalizeUrls(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => {
      if (typeof entry === "string") return { label: entry, url: entry };
      if (entry && typeof entry.url === "string") {
        return { label: entry.label ?? entry.url, url: entry.url };
      }
      return null;
    })
    .filter(Boolean);
}

function pickInitialIndex(options, initial) {
  if (initial === null || initial === undefined) return -1;
  if (typeof initial === "number") {
    return initial >= 0 && initial < options.length ? initial : -1;
  }
  if (typeof initial === "string") {
    const i = options.findIndex((o) => o.url === initial);
    return i >= 0 ? i : -1;
  }
  return -1;
}

function render({ model, el }) {
  const options = normalizeUrls(model.get("urls"));
  const eventName = model.get("event") ?? "cog-url-change";
  const labelText = model.get("label") ?? "COG:";
  const initial = model.get("initial") ?? 0;

  if (options.length === 0) {
    el.textContent = "cog-selector: 'urls' parameter is required and must be a non-empty array.";
    return;
  }

  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    display: "flex",
    alignItems: "center",
    gap: "0.5em",
    font: "14px/1.4 system-uI, sans-serif",
    margin: "0.5em 0",
  });

  const labelEl = document.createElement("label");
  labelEl.textContent = labelText;
  labelEl.style.fontWeight = "600";

  const select = document.createElement("select");
  Object.assign(select.style, {
    flex: "1 1 auto",
    padding: "4px 6px",
    font: "inherit",
  });
  const selectId = `cog-selector-${Math.random().toString(36).slice(2, 8)}`;
  select.id = selectId;
  labelEl.htmlFor = selectId;

  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.url;
    o.textContent = opt.label;
    select.appendChild(o);
  }

  const initialIdx = pickInitialIndex(options, initial);
  if (initialIdx >= 0) select.selectedIndex = initialIdx;

  const dispatch = (url) => {
    // Stash latest on a global keyed by event name so a late-mounting viewer
    // can pick it up even if it missed the live event.
    if (!window.__cogSelectorLatest) window.__cogSelectorLatest = {};
    window.__cogSelectorLatest[eventName] = url;
    window.dispatchEvent(new CustomEvent(eventName, { detail: { url } }));
  };

  const onChange = () => dispatch(select.value);
  select.addEventListener("change", onChange);

  wrap.appendChild(labelEl);
  wrap.appendChild(select);
  el.appendChild(wrap);

  // Fire once on mount so subscribed viewers have something to show before
  // any user interaction. Schedule it for the next microtask so subscribers
  // mounted in parallel get a chance to attach their listener first.
  if (initialIdx >= 0) {
    queueMicrotask(() => dispatch(options[initialIdx].url));
  }

  return () => {
    select.removeEventListener("change", onChange);
    el.replaceChildren();
  };
}

export default { render };
