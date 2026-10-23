import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import type { SkillInfo } from "../../hooks/useSkills";
import { ArrowUp, Square } from "lucide-react";

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
    <form className="relative px-5 pb-5 pt-2" onSubmit={handleSubmit}>
      {suggestions.length > 0 ? (
        <ul
          className="absolute inset-x-5 bottom-full m-0 max-h-60 list-none overflow-y-auto rounded-xl border border-border bg-canvas p-1 shadow-lg"
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
      <div className="rounded-2xl border border-border bg-input shadow-sm transition-colors focus-within:border-accent">
        <textarea
          ref={textareaRef}
          className="block max-h-50 w-full resize-none border-0 bg-transparent px-4 pb-1 pt-3 font-[inherit] leading-normal text-ink field-sizing-content placeholder:text-muted focus:outline-none"
          placeholder={skills.length > 0 ? "Send a message, or / for skills…" : "Send a message…"}
          value={value}
          rows={1}
          onChange={(event) => change(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="flex items-center gap-3 pb-2.5 pl-4 pr-2.5">
          <span className="flex-1 text-xs text-muted">Enter to send · Shift+Enter for newline</span>
          {isRunning ? (
            <button
              type="button"
              className="grid size-8 cursor-pointer place-items-center rounded-full border border-border bg-canvas text-ink transition-colors hover:border-danger hover:text-danger"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              className="grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-accent-strong text-white transition-colors enabled:hover:bg-accent disabled:cursor-default disabled:bg-border disabled:text-muted"
              disabled={!value.trim()}
              aria-label="Send"
              title="Send"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
