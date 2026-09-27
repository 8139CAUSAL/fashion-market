// Entry point for the vendored editor bundle (tools/build-editor.mjs).
//
// Only the pieces the Workbench actually uses: no autocomplete, search or
// lint. Bundling them together guarantees one copy of @codemirror/state and
// @codemirror/view, which is what CodeMirror's extension system requires.

export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
export { EditorState, Compartment } from "@codemirror/state";
export { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
export {
  StreamLanguage, HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching,
} from "@codemirror/language";
export { tags } from "@lezer/highlight";
export { r as rMode } from "@codemirror/legacy-modes/mode/r";
