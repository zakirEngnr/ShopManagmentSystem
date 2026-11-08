export default function POS() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-indigo-500" />
        <h2 className="text-xl font-semibold text-slate-900">Point of Sale</h2>
      </div>
      <p className="text-sm text-slate-600">Scan products, build cart, checkout.</p>
      <div className="mt-8 p-4 rounded-lg bg-amber-50 border border-amber-200">
        <h3 className="text-sm font-semibold text-amber-800">Placeholder</h3>
        <p className="text-sm text-amber-700 mt-1">
          POS functionality will be implemented in a later task. No cart or checkout
          logic exists here yet.
        </p>
      </div>
    </div>
  );
}
