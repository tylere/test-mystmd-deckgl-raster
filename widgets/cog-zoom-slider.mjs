// Anywidget zoom slider.
//
// Renders an <input type="range"> that drives a sibling COG viewer's zoom
// level via a window CustomEvent bus, and reflects the viewer's zoom back so
// the slider always shows the current map zoom (whether the user is dragging
// the slider, scrolling the wheel on the map, or the viewer just ran
// fitBounds on a new COG).
//
// Event payload: detail: { zoom: number, source: "slider" | "map" }
// The `source` field lets each endpoint distinguish its own outgoing
// broadcasts from the other side's broadcasts and avoid feedback loops.
//
// Params (from the directive JSON body):
//   min   : number  default 0
//   max   : number  default 22
//   step  : number  default 0.5
//   value : number | null  default null (start inert; first map fitBounds primes the UI)
//   event : string  default "cog-zoom-change"
//   label : string  default "Zoom:"

function render({ model, el }) {
  const min = Number(model.get("min") ?? 0);
  const max = Number(model.get("max") ?? 22);
  const step = Number(model.get("step") ?? 0.5);
  const initialValue = (() => {
    const v = model.get("value");
    return v === null || v === undefined ? null : Number(v);
  })();
  const eventName = model.get("event") ?? "cog-zoom-change";
  const labelText = model.get("label") ?? "Zoom:";

  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    display: "flex",
    alignItems: "center",
    gap: "0.5em",
    font: "14px/1.4 system-ui, sans-serif",
    margin: "0.5em 0",
  });

  const labelEl = document.createElement("label");
  labelEl.textContent = labelText;
  labelEl.style.fontWeight = "600";

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  Object.assign(input.style, { flex: "1 1 auto" });
  const inputId = `cog-zoom-slider-${Math.random().toString(36).slice(2, 8)}`;
  input.id = inputId;
  labelEl.htmlFor = inputId;

  const output = document.createElement("output");
  Object.assign(output.style, {
    minWidth: "3.5em",
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
  });

  const formatZoom = (z) => z.toFixed(Math.max(0, -Math.floor(Math.log10(step))));
  const setUi = (z) => {
    input.value = String(z);
    output.textContent = formatZoom(z);
  };
  setUi(initialValue ?? (min + max) / 2);
  if (initialValue === null) output.textContent = "—";

  wrap.appendChild(labelEl);
  wrap.appendChild(input);
  wrap.appendChild(output);
  el.appendChild(wrap);

  const dispatch = (zoom, source = "slider") => {
    if (!window.__cogZoomLatest) window.__cogZoomLatest = {};
    window.__cogZoomLatest[eventName] = zoom;
    window.dispatchEvent(new CustomEvent(eventName, { detail: { zoom, source } }));
  };

  const onInput = () => dispatch(Number(input.value), "slider");
  input.addEventListener("input", onInput);

  // Listen for map-sourced broadcasts and reflect them in the UI.
  // Programmatically assigning to input.value does NOT fire "input", so this
  // is loop-safe — we never rebroadcast in response to a received event.
  const onWindowEvent = (e) => {
    const detail = e?.detail;
    if (!detail || typeof detail.zoom !== "number") return;
    if (detail.source === "slider") return; // our own echo, ignore
    setUi(detail.zoom);
  };
  window.addEventListener(eventName, onWindowEvent);

  // Fire once on mount if an explicit initial value was provided, so a
  // subscribed viewer can apply it after its first fitBounds.
  if (initialValue !== null) {
    queueMicrotask(() => dispatch(initialValue, "slider"));
  }

  return () => {
    input.removeEventListener("input", onInput);
    window.removeEventListener(eventName, onWindowEvent);
    el.replaceChildren();
  };
}

export default { render };
