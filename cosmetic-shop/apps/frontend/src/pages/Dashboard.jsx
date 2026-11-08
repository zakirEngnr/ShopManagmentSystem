export default function Dashboard() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-indigo-500" />
        <h2 className="text-xl font-semibold text-slate-900">Dashboard</h2>
      </div>
      <p className="text-sm text-slate-600">Today's overview will appear here.</p>
      <div className="mt-8 p-4 rounded-lg bg-amber-50 border border-amber-200">
        <h3 className="text-sm font-semibold text-amber-800">Placeholder</h3>
        <p className="text-sm text-amber-700 mt-1">
          Dashboard statistics will be integrated with the existing reports API in a
          later task. No business data is displayed here yet.
        </p>
      </div>
    </div>
  );
}
