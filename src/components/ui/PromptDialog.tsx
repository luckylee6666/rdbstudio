import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Input, Label } from "./Field";

// Replacement for window.prompt(), which is disabled in Tauri's webview. Mounts
// an autofocused input inside a Modal so flows like "new group" / "rename"
// keep working in the desktop app.
export function PromptDialog({
  open,
  title,
  label,
  initialValue = "",
  placeholder,
  submitLabel = "OK",
  cancelLabel = "Cancel",
  suggestions,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  cancelLabel?: string;
  /** Values to expose via <datalist> for autocompletion. */
  suggestions?: string[];
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset value whenever the dialog opens with a new initialValue, and focus
  // the input on the next tick so the Modal mount finishes first.
  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    const h = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(h);
  }, [open, initialValue]);

  const submit = () => {
    onSubmit(value);
    onClose();
  };

  const listId = suggestions && suggestions.length ? "rdb-prompt-suggest" : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant="primary" onClick={submit}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {label && <Label>{label}</Label>}
        <Input
          ref={inputRef}
          value={value}
          list={listId}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        {listId && (
          <datalist id={listId}>
            {suggestions!.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
    </Modal>
  );
}
