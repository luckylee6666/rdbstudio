import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const rdbTheme = EditorView.theme(
  {
    "&": {
      color: "hsl(var(--foreground))",
      backgroundColor: "transparent",
      height: "100%",
      fontSize: "var(--editor-font-size, 13px)",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-content": {
      fontFamily:
        "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      caretColor: "hsl(var(--brand))",
      padding: "14px 0",
    },
    ".cm-line": {
      padding: "0 16px",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "hsl(var(--brand))",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackgroundc, ::selection, .cm-selectionBackground":
      {
        backgroundColor: "hsl(var(--brand) / 0.25) !important",
      },
    ".cm-activeLine": {
      backgroundColor: "hsl(var(--accent) / 0.35)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "hsl(var(--muted-foreground) / 0.6)",
      border: "none",
      paddingRight: "8px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "hsl(var(--foreground))",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 16px",
      minWidth: "38px",
      textAlign: "right",
    },
    ".cm-foldGutter .cm-gutterElement": {
      color: "hsl(var(--muted-foreground) / 0.6)",
    },
    ".cm-panels": {
      backgroundColor: "hsl(var(--surface-elevated))",
      color: "hsl(var(--foreground))",
    },
    ".cm-tooltip": {
      backgroundColor: "hsl(var(--surface-elevated))",
      border: "1px solid hsl(var(--border))",
      borderRadius: "8px",
      boxShadow: "0 10px 30px -12px rgb(0 0 0 / 0.4)",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      padding: "4px 10px",
      fontFamily: "inherit",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "hsl(var(--brand) / 0.18)",
      color: "hsl(var(--foreground))",
    },
    ".cm-scroller": {
      overflow: "auto",
    },
  },
  { dark: true }
);

export const rdbHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: "hsl(var(--syntax-keyword))", fontWeight: "600" },
    { tag: [t.operator, t.operatorKeyword], color: "hsl(var(--syntax-operator))" },
    { tag: [t.string, t.special(t.string)], color: "hsl(var(--syntax-string))" },
    { tag: t.number, color: "hsl(var(--syntax-number))" },
    { tag: t.bool, color: "hsl(var(--syntax-number))" },
    { tag: t.null, color: "hsl(var(--syntax-number))" },
    { tag: [t.variableName, t.propertyName], color: "hsl(var(--foreground))" },
    { tag: t.typeName, color: "hsl(var(--syntax-type))" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "hsl(var(--syntax-function))" },
    { tag: t.comment, color: "hsl(var(--muted-foreground) / 0.8)", fontStyle: "italic" },
    { tag: t.lineComment, color: "hsl(var(--muted-foreground) / 0.8)", fontStyle: "italic" },
    { tag: t.punctuation, color: "hsl(var(--muted-foreground))" },
  ])
);
