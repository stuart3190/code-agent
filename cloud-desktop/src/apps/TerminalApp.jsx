import { useRef, useState } from "react";
import { CaretRight, Info, Plus, X } from "@phosphor-icons/react";

const commandOutput = Object.freeze({
  help: ["Available fixture commands:", "help  ls  pwd  whoami  git status  clear"],
  ls: ["customer-portal/", "launch-campaign/", "README.md", "workspace.json"],
  pwd: ["/workspace/atlas"],
  whoami: ["thrallo-fixture-user"],
  "git status": ["On branch main", "Your branch is up to date with 'origin/main'.", "nothing to commit, working tree clean"],
});

const welcomeLines = [
  { kind: "system", text: "Thrallo Fixture Terminal · no shell process" },
  { kind: "system", text: "Type help to see deterministic commands." },
];

export function evaluateFixtureCommand(input) {
  const command = String(input).trim().replace(/\s+/g, " ");
  if (!command) return { clear: false, lines: [] };
  if (command === "clear") return { clear: true, lines: [] };
  const output = commandOutput[command] ?? [`Command not available in C1 fixture: ${command}`, "Type help for the safe command list."];
  return { clear: false, lines: output.map((text) => ({ kind: commandOutput[command] ? "output" : "error", text })) };
}

export function TerminalApp() {
  const [sessions, setSessions] = useState([{ id: 1, title: "Fixture shell", lines: welcomeLines }]);
  const [activeSession, setActiveSession] = useState(1);
  const [input, setInput] = useState("");
  const inputRef = useRef(null);
  const session = sessions.find((entry) => entry.id === activeSession) ?? sessions[0];

  const submit = (event) => {
    event.preventDefault();
    const command = input.trim();
    const result = evaluateFixtureCommand(command);
    setSessions((current) => current.map((entry) => {
      if (entry.id !== activeSession) return entry;
      if (result.clear) return { ...entry, lines: welcomeLines };
      return { ...entry, lines: [...entry.lines, { kind: "command", text: `fixture@atlas:~$ ${command}` }, ...result.lines] };
    }));
    setInput("");
  };

  const addSession = () => {
    const id = Math.max(...sessions.map((entry) => entry.id)) + 1;
    setSessions((current) => [...current, { id, title: `Fixture shell ${id}`, lines: welcomeLines }]);
    setActiveSession(id);
  };

  return (
    <div className="app-view terminal-app" data-testid="terminal-app" onClick={() => inputRef.current?.focus()}>
      <div className="terminal-tabs" role="tablist" aria-label="Fixture terminal sessions">
        {sessions.map((entry) => <button key={entry.id} role="tab" aria-selected={entry.id === activeSession} onClick={(event) => { event.stopPropagation(); setActiveSession(entry.id); }}><CaretRight /> {entry.title}{sessions.length > 1 && <X aria-label={`Close ${entry.title}`} onClick={(event) => { event.stopPropagation(); const next = sessions.filter((item) => item.id !== entry.id); setSessions(next); if (activeSession === entry.id) setActiveSession(next[0].id); }} />}</button>)}
        <button aria-label="New fixture terminal" onClick={(event) => { event.stopPropagation(); addSession(); }}><Plus /></button>
      </div>
      <div className="terminal-notice"><Info /> Deterministic fixture · commands never reach a real shell</div>
      <div className="terminal-output" aria-live="polite">{session.lines.map((line, index) => <div key={`${line.text}-${index}`} className={`terminal-line line-${line.kind}`}>{line.text}</div>)}</div>
      <form className="terminal-input" onSubmit={submit}><span>fixture@atlas:~$</span><input ref={inputRef} aria-label="Fixture terminal command" autoComplete="off" spellCheck="false" value={input} onChange={(event) => setInput(event.target.value)} /></form>
    </div>
  );
}
