import { useMemo } from 'react';

const orders = [
  { id: 'ORD-1001', customer: 'Acme Co', total: 420, status: 'paid' },
  { id: 'ORD-1002', customer: 'Globex', total: 180, status: 'pending' },
  { id: 'ORD-1003', customer: 'Initech', total: 960, status: 'paid' },
  { id: 'ORD-1004', customer: 'Umbrella', total: 75, status: 'paid' },
  { id: 'ORD-1005', customer: 'Soylent', total: 240, status: 'pending' },
  { id: 'ORD-1006', customer: 'Hooli', total: 510, status: 'paid' },
];

function StatCard({ label, value, hint }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-lg">
      <p className="text-xs font-semibold uppercase tracking-widest text-cyan-300">{label}</p>
      <p className="mt-2 text-3xl font-bold text-slate-50">{value}</p>
      {hint ? <p className="mt-1 text-sm text-slate-400">{hint}</p> : null}
    </div>
  );
}

export default function App() {
  const totalRevenue = useMemo(
    () => orders.reduce((sum, o) => sum + o.total, 0),
    [],
  );

  const paidCount = useMemo(() => {
    let n = 0;
    for (const o of orders) if (o.status === 'paid') n += 1;
    return n;
  }, []);

  const avgOrder = Math.round(totalRevenue / orders.length);

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100 sm:px-6">
      <section className="mx-auto max-w-4xl">
        <header className="mb-8">
          <p className="mb-1 text-sm font-semibold uppercase tracking-[0.3em] text-cyan-300">
            Sales Dashboard
          </p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Orders overview</h1>
        </header>

        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label="Total revenue" value={`£${totalRevenue}`} hint="all orders" />
          <StatCard label="Orders" value={orders.length} hint={`${paidCount} paid`} />
          <StatCard label="Avg order" value={`£${avgOrder}`} hint="per order" />
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/5 text-xs uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-white/5">
                  <td className="px-4 py-3 font-mono text-slate-300">{o.id}</td>
                  <td className="px-4 py-3 text-slate-100">{o.customer}</td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        o.status === 'paid'
                          ? 'rounded-full bg-emerald-400/10 px-2 py-1 text-xs font-semibold text-emerald-300'
                          : 'rounded-full bg-amber-400/10 px-2 py-1 text-xs font-semibold text-amber-300'
                      }
                    >
                      {o.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-100">£{o.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
