import { useMemo, useState } from 'react';

const FILTERS = {
  all: 'All',
  active: 'Active',
  completed: 'Completed',
};

const initialTodos = [
  { id: 1, text: 'Add your first task', completed: false },
  { id: 2, text: 'Mark a task complete', completed: true },
];

export default function App() {
  const [todos, setTodos] = useState(initialTodos);
  const [newTodo, setNewTodo] = useState('');
  const [filter, setFilter] = useState('all');

  const filteredTodos = useMemo(() => {
    if (filter === 'active') return todos.filter((todo) => !todo.completed);
    if (filter === 'completed') return todos.filter((todo) => todo.completed);
    return todos;
  }, [todos, filter]);

  const activeCount = todos.filter((todo) => !todo.completed).length;
  const completedCount = todos.length - activeCount;

  function addTodo(event) {
    event.preventDefault();
    const text = newTodo.trim();
    if (!text) return;

    setTodos((currentTodos) => [
      { id: Date.now(), text, completed: false },
      ...currentTodos,
    ]);
    setNewTodo('');
  }

  function toggleTodo(id) {
    setTodos((currentTodos) =>
      currentTodos.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo,
      ),
    );
  }

  function clearCompleted() {
    setTodos((currentTodos) => currentTodos.filter((todo) => !todo.completed));
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100 sm:px-6">
      <section className="mx-auto max-w-2xl">
        <div className="mb-8 text-center">
          <p className="mb-2 text-sm font-semibold uppercase tracking-[0.3em] text-cyan-300">
            Simple Todo
          </p>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Stay on top of your day
          </h1>
          <p className="mt-4 text-slate-400">
            Add tasks, mark them complete, and filter your list by status.
          </p>
        </div>

        <div className="rounded-3xl border border-white/10 bg-white/10 p-5 shadow-2xl shadow-cyan-950/40 backdrop-blur sm:p-6">
          <form onSubmit={addTodo} className="flex flex-col gap-3 sm:flex-row">
            <label htmlFor="todo-input" className="sr-only">
              New todo
            </label>
            <input
              id="todo-input"
              type="text"
              value={newTodo}
              onChange={(event) => setNewTodo(event.target.value)}
              placeholder="What needs to be done?"
              className="min-h-12 flex-1 rounded-2xl border border-white/10 bg-slate-900/80 px-4 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300 focus:ring-4 focus:ring-cyan-300/10"
            />
            <button
              type="submit"
              className="min-h-12 rounded-2xl bg-cyan-300 px-6 font-bold text-slate-950 transition hover:bg-cyan-200 focus:outline-none focus:ring-4 focus:ring-cyan-300/30"
            >
              Add task
            </button>
          </form>

          <div className="mt-5 flex flex-col gap-4 border-y border-white/10 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-slate-400">
              <span className="font-semibold text-slate-100">{activeCount}</span>{' '}
              active ·{' '}
              <span className="font-semibold text-slate-100">{completedCount}</span>{' '}
              completed
            </div>

            <div className="flex rounded-2xl bg-slate-950/60 p-1">
              {Object.entries(FILTERS).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                    filter === key
                      ? 'bg-cyan-300 text-slate-950 shadow-lg shadow-cyan-950/30'
                      : 'text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <ul className="mt-5 space-y-3">
            {filteredTodos.length > 0 ? (
              filteredTodos.map((todo) => (
                <li
                  key={todo.id}
                  className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-3 transition hover:border-cyan-300/40"
                >
                  <button
                    type="button"
                    onClick={() => toggleTodo(todo.id)}
                    aria-label={todo.completed ? 'Mark incomplete' : 'Mark complete'}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition ${
                      todo.completed
                        ? 'border-cyan-300 bg-cyan-300 text-slate-950'
                        : 'border-slate-500 text-transparent hover:border-cyan-300'
                    }`}
                  >
                    <span className="text-sm font-black">✓</span>
                  </button>
                  <span
                    className={`flex-1 break-words text-base ${
                      todo.completed
                        ? 'text-slate-500 line-through'
                        : 'text-slate-100'
                    }`}
                  >
                    {todo.text}
                  </span>
                </li>
              ))
            ) : (
              <li className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-slate-400">
                No {filter === 'all' ? '' : filter} tasks to show.
              </li>
            )}
          </ul>

          {completedCount > 0 && (
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={clearCompleted}
                className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-400 transition hover:bg-white/10 hover:text-slate-100"
              >
                Clear completed
              </button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
