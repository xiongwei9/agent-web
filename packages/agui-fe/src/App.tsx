import { Chat } from "./components/Chat";

export function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-elevated px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="text-xl text-accent" aria-hidden="true">
            ◆
          </span>
          <h1 className="m-0 text-[17px] font-semibold">AG-UI Chat</h1>
        </div>
      </header>
      <Chat />
    </div>
  );
}
