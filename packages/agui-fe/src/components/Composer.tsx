import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type { SkillInfo } from "../hooks/useSkills";

interface ComposerProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isRunning: boolean;
  /** Offered as `/skill-name` commands while the message starts with `/`. */
  skills: SkillInfo[];
}

/** The command being typed: a leading `/` and no whitespace yet. */
const PARTIAL_COMMAND_RE = /^\/(\S*)$/;

export function Composer({ onSend, onStop, isRunning, skills }: ComposerProps) {
  const [value, setValue] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  // Escape hides the suggestions until the text changes again.
  const [dismissed, setDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const partial = PARTIAL_COMMAND_RE.exec(value)?.[1];
  const suggestions =
    partial === undefined || dismissed
      ? []
      : skills.filter((skill) => skill.name.startsWith(partial.toLowerCase()));
  const active = Math.min(highlighted, Math.max(suggestions.length - 1, 0));

  const change = (next: string) => {
    setValue(next);
    setHighlighted(0);
    setDismissed(false);
  };

  const pick = (skill: SkillInfo) => {
    change(`/${skill.name} `);
    textareaRef.current?.focus();
  };

  const submit = () => {
    const text = value.trim();
    if (!text || isRunning) {
      return;
    }
    onSend(text);
    change("");
    textareaRef.current?.focus();
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlighted((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        pick(suggestions[active]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="relative flex items-end gap-2.5 border-t border-border bg-canvas px-5 pb-5.5 pt-3.5"
      onSubmit={handleSubmit}
    >
      {suggestions.length > 0 ? (
        <ul
          className="absolute inset-x-5 bottom-full m-0 mb-1.5 max-h-60 list-none overflow-y-auto rounded-xl border border-border bg-canvas p-1 shadow-lg"
          role="listbox"
          aria-label="Skills"
        >
          {suggestions.map((skill, index) => (
            <li key={skill.name} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-lg border-0 px-3 py-2 text-left ${
                  index === active ? "bg-elevated" : "bg-transparent"
                }`}
                // Keep the textarea focused so the keyboard keeps working.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => pick(skill)}
              >
                <span className="font-mono text-[13px] font-semibold text-ink">/{skill.name}</span>
                <span className="line-clamp-2 text-xs text-muted">{skill.description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={textareaRef}
        className="max-h-50 flex-1 resize-none rounded-xl border border-border bg-input px-3.5 py-3 font-[inherit] leading-normal text-ink field-sizing-content focus:border-accent focus:outline-none"
        placeholder={
          skills.length > 0
            ? "Send a message, or / for skills…  (Enter to send, Shift+Enter for newline)"
            : "Send a message…  (Enter to send, Shift+Enter for newline)"
        }
        value={value}
        rows={1}
        onChange={(event) => change(event.target.value)}
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
