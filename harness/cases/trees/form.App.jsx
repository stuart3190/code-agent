import { useState } from 'react';

const EMPTY = { name: '', email: '', password: '' };

function validate(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = 'Name is required.';
  if (!values.email.trim()) {
    errors.email = 'Email is required.';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.email = 'Enter a valid email address.';
  }
  if (values.password.length < 8) {
    errors.password = 'Password must be at least 8 characters.';
  }
  return errors;
}

export default function App() {
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);

  function update(field) {
    return (event) => setValues((v) => ({ ...v, [field]: event.target.value }));
  }

  function onSubmit(event) {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length === 0) {
      setSubmitted(true);
    }
  }

  const field =
    'min-h-11 w-full rounded-xl border border-white/10 bg-slate-900/80 px-4 text-slate-100 outline-none transition focus:border-cyan-300 focus:ring-4 focus:ring-cyan-300/10';

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100 sm:px-6">
      <section className="mx-auto max-w-md">
        <h1 className="mb-6 text-3xl font-bold tracking-tight">Create your account</h1>

        {submitted ? (
          <p className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-emerald-200">
            Account created. Welcome, {values.name}!
          </p>
        ) : (
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <div>
              <label htmlFor="name" className="mb-1 block text-sm font-semibold text-slate-300">
                Name
              </label>
              <input id="name" type="text" value={values.name} onChange={update('name')} className={field} />
              {errors.name ? <p className="mt-1 text-sm text-rose-300">{errors.name}</p> : null}
            </div>

            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-semibold text-slate-300">
                Email
              </label>
              <input id="email" type="email" value={values.email} onChange={update('email')} className={field} />
              {errors.email ? <p className="mt-1 text-sm text-rose-300">{errors.email}</p> : null}
            </div>

            <div>
              <label htmlFor="password" className="mb-1 block text-sm font-semibold text-slate-300">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={values.password}
                onChange={update('password')}
                className={field}
              />
              {errors.password ? <p className="mt-1 text-sm text-rose-300">{errors.password}</p> : null}
            </div>

            <button
              type="submit"
              className="min-h-11 w-full rounded-xl bg-cyan-300 font-bold text-slate-950 transition hover:bg-cyan-200"
            >
              Sign up
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
