// Code editors for the workbench drawer.
//
// CodeMirror is vendored (vendor/codemirror.js) rather than loaded from a
// CDN, so the Workbench stays static files that work offline and under
// cross-origin isolation. If the bundle can't load for any reason, the
// plain textarea underneath keeps working — the app never depends on it.

const VENDOR_URL = new URL("../vendor/codemirror.js", import.meta.url).href;

// Syntax colours come from CSS variables, so the editors follow the app's
// light and dark themes without rebuilding the theme in JavaScript.
const THEME_STYLES = {
  "&": {
    height: "100%",
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    fontSize: "13px",
  },
  ".cm-content": {
    fontFamily: "var(--font-code)",
    padding: "10px 0",
    caretColor: "var(--accent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--text-muted)",
    border: "none",
    paddingRight: "4px",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)",
  },
  ".cm-scroller": { overflow: "auto", lineHeight: "1.55" },
};

// The interface spec: one widget per line, with R reporters in braces, and
// panel/for blocks closed by `end`.
function specMode() {
  const WIDGETS = new Set(["button", "slider", "switch", "chooser", "input", "monitor", "note", "output", "view", "import", "plot", "report", "panel", "for", "end"]);
  const SETTINGS = new Set(["forever", "step", "digits", "w", "h", "in", "if", "and", "or", "world", "turtles", "layer", "none", "colors", "palette", "shape", "accept", "update", "ticks", "manual"]);

  return {
    name: "workbench-spec",
    startState: () => ({ depth: 0, start: true }),
    token(stream, state) {
      // Outside an R block, each line begins a new widget.
      if (stream.sol() && state.depth === 0) state.start = true;

      // Inside a { } block everything is R code.
      if (state.depth > 0) {
        if (stream.eat("{")) state.depth++;
        else if (stream.eat("}")) state.depth--;
        else stream.next();
        return "meta";
      }

      if (stream.eatSpace()) return null;
      if (stream.eat("#")) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.eat("{")) {
        state.depth++;
        return "meta";
      }
      if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
      if (stream.match(/^\[[^\]]*\]?/)) return "atom";
      if (stream.match(/^\.(under|right|left|above)\b/)) return "operator";
      if (stream.match(/^(==|!=)/)) return "operator";
      if (stream.match(/^-?\d+(?:\.\d+)?(?:\.\.-?\d+(?:\.\d+)?)?/)) return "number";
      if (stream.match(/^[A-Za-z_.][A-Za-z0-9._?]*/)) {
        const word = stream.current().toLowerCase();
        if (state.start && WIDGETS.has(word)) {
          state.start = false;
          return "keyword";
        }
        state.start = false;
        if (SETTINGS.has(word)) return "attribute";
        if (["on", "off", "true", "false"].includes(word)) return "atom";
        return "variable";
      }
      stream.next();
      return null;
    },
    copyState: (state) => ({ ...state }),
  };
}

// Wraps a textarea so callers can treat it like an editor.
function textareaAdapter(textarea, onChange) {
  if (onChange) textarea.addEventListener("input", () => onChange(textarea.value));
  return {
    kind: "textarea",
    getValue: () => textarea.value,
    setValue: (value) => { textarea.value = value; },
    focus: () => textarea.focus(),
  };
}

let vendorPromise = null;
const loadVendor = () => (vendorPromise ??= import(VENDOR_URL));

// Replaces a textarea with a CodeMirror editor, falling back to the
// textarea if the bundle is unavailable.
export async function attachEditor(textarea, { language = "spec", onChange } = {}) {
  let cm;
  try {
    cm = await loadVendor();
  } catch (err) {
    console.warn("[editor] CodeMirror unavailable; using a plain text box.", err);
    return textareaAdapter(textarea, onChange);
  }

  const { EditorView, EditorState, StreamLanguage, HighlightStyle, syntaxHighlighting, tags } = cm;

  const highlight = HighlightStyle.define([
    { tag: tags.keyword, color: "var(--syn-keyword)", fontWeight: "600" },
    { tag: tags.comment, color: "var(--syn-comment)", fontStyle: "italic" },
    { tag: tags.string, color: "var(--syn-string)" },
    { tag: tags.number, color: "var(--syn-number)" },
    { tag: tags.atom, color: "var(--syn-atom)" },
    { tag: tags.operator, color: "var(--syn-operator)" },
    { tag: tags.attributeName, color: "var(--syn-attribute)" },
    { tag: tags.meta, color: "var(--syn-meta)" },
    { tag: tags.variableName, color: "var(--text)" },
    { tag: tags.function(tags.variableName), color: "var(--syn-keyword)" },
  ]);

  const parser = language === "r" ? cm.rMode : specMode();

  const view = new EditorView({
    state: EditorState.create({
      doc: textarea.value,
      extensions: [
        cm.lineNumbers(),
        cm.highlightActiveLine(),
        cm.highlightActiveLineGutter(),
        cm.drawSelection(),
        cm.history(),
        cm.bracketMatching(),
        cm.indentOnInput(),
        cm.keymap.of([...cm.defaultKeymap, ...cm.historyKeymap, cm.indentWithTab]),
        StreamLanguage.define(parser),
        syntaxHighlighting(highlight),
        EditorView.theme(THEME_STYLES),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange?.(update.state.doc.toString());
        }),
      ],
    }),
  });

  view.dom.classList.add("editor-host");
  textarea.replaceWith(view.dom);

  return {
    kind: "codemirror",
    getValue: () => view.state.doc.toString(),
    setValue: (value) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    },
    focus: () => view.focus(),
  };
}
