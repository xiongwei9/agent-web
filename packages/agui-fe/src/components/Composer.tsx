import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";

interface ComposerProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isRunning: boolean;
}

export function Composer({ onSend, onStop, isRunning }: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = value.trim();
    if (!text || isRunning) {
      return;
    }
    onSend(text);
    setValue("");
    textareaRef.current?.focus();
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="flex items-end gap-2.5 border-t border-border bg-canvas px-5 pb-5.5 pt-3.5"
      onSubmit={handleSubmit}
    >
      <textarea
        ref={textareaRef}
        className="max-h-50 flex-1 resize-none rounded-xl border border-border bg-input px-3.5 py-3 font-[inherit] leading-normal text-ink field-sizing-content focus:border-accent focus:outline-none"
        placeholder="Send a message…  (Enter to send, Shift+Enter for newline)"
        value={value}
        rows={1}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {isRunning ? (
        <button
          type="button"
          className="cursor-pointer whitespace-nowrap rounded-xl border border-danger bg-transparent px-5 py-3 text-sm font-semibold text-danger hover:bg-danger/10"
          onClick={onStop}
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          className="cursor-pointer whitespace-nowrap rounded-xl border-0 bg-accent-strong px-5 py-3 text-sm font-semibold text-white enabled:hover:bg-accent disabled:cursor-default disabled:opacity-50"
          disabled={!value.trim()}
        >
          Send
        </button>
      )}
    </form>
  );
}
