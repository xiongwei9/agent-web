import type { ReactNode } from "react";

/** A user's turn: a right-hand bubble that keeps the text's line breaks. */
export function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[85%] self-end whitespace-pre-wrap wrap-break-word rounded-2xl rounded-br-md bg-user-bubble px-4 py-2.5">
      {children}
    </div>
  );
}
