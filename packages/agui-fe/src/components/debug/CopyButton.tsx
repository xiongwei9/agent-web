import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** Copies `text` to the clipboard, confirming with a check mark for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <button
      type="button"
      className="inline-flex cursor-pointer items-center rounded-md border border-border bg-canvas p-1 text-muted transition-colors hover:text-ink"
      onClick={copy}
      title={label}
      aria-label={label}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}
