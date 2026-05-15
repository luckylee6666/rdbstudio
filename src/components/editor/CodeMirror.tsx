import { useEffect, useMemo, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import { sql } from "@codemirror/lang-sql";
import { rdbHighlight, rdbTheme } from "./sql-theme";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun?: (opts: { selection?: string }) => void;
  // Map of table name → column names for SQL autocomplete. Empty arrays still
  // surface table-name completion via @codemirror/lang-sql's schema option.
  schema?: Record<string, string[]>;
  className?: string;
}

export function CodeMirrorEditor({ value, onChange, onRun, schema, className }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;
  const themeCompartment = useRef(new Compartment());
  const sqlCompartment = useRef(new Compartment());

  // Stable schema key so dispatch only fires when the actual table set changes.
  const schemaKey = useMemo(() => {
    if (!schema) return "";
    const names = Object.keys(schema).sort();
    return names.map((n) => `${n}:${schema[n].join(",")}`).join("|");
  }, [schema]);

  useEffect(() => {
    if (!hostRef.current) return;

    const runCommand = () => {
      const v = viewRef.current;
      if (!v) return true;
      const sel = v.state.selection.main;
      const selected = sel.empty
        ? undefined
        : v.state.sliceDoc(sel.from, sel.to);
      onRunRef.current?.({ selection: selected });
      return true;
    };

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        history(),
        highlightSelectionMatches(),
        sqlCompartment.current.of(sql({ schema: schema ?? {} })),
        themeCompartment.current.of([rdbTheme, rdbHighlight]),
        keymap.of([
          { key: "Mod-Enter", preventDefault: true, run: runCommand },
          { key: "Mod-r", preventDefault: true, run: runCommand },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            onChangeRef.current(u.state.doc.toString());
          }
        }),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== value) {
      v.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
      });
    }
  }, [value]);

  // Re-configure the SQL extension when the schema changes (eg. user switches
  // target connection, or the tree finishes loading tables) so autocomplete
  // keeps suggesting the right table set without rebuilding the whole editor.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({
      effects: sqlCompartment.current.reconfigure(
        sql({ schema: schema ?? {} })
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  return <div ref={hostRef} className={className} style={{ height: "100%" }} />;
}
