// A fake transport for the expense API.
//
// The Axios adapter of the REAL API client is replaced, so the real API
// helpers (src/api/expenses.js) build the real requests and the real
// response validation runs. Only the socket is faked.
//
// The answers follow the contract of the real backend
// (apps/backend/src/services/expense.service.js), which was verified against
// a disposable backend:
//
//   * a list without `includeDeleted` contains ONLY the rows whose
//     `deletedAt` is null;
//   * a list with `includeDeleted=true` contains EVERY row, active and
//     archived, because the archived rows are selected by the client;
//   * a list with `includeDeleted=only` contains ONLY the archived rows;
//   * `cumulativeTotals` is grouped over the rows of the SAME query, so every
//     view only ever contains the totals of the rows of that view;
//   * `totalPages` is `ceil(total / limit)` and is 0 for an empty result;
//   * a restore answers `{ ok: true, expense }` and an error answers
//     `{ ok: false, error: { message } }`.

/** The rows the stub serves. */
const DEFAULT_ROWS = [];

/**
 * Install the stub on an Axios client.
 *
 * @param {object} client - The Axios instance of the API client.
 * @param {object} [options]
 * @param {Array} [options.rows] - The expense rows the list answers with.
 * @returns {object} The state of the stub.
 */
export function installExpenseApiStub(client, options = {}) {
  const state = {
    /** Every request the client made, in order. */
    requests: [],
    /** The rows the list answers with. */
    rows: options.rows ?? DEFAULT_ROWS,
    /** Called instead of the default restore answer. */
    onRestore: options.onRestore ?? null,
    /** Called instead of the default list answer. */
    onList: options.onList ?? null,
  };

  const previousAdapter = client.defaults.adapter;

  client.defaults.adapter = async (config) => {
    const request = {
      url: String(config.url ?? ''),
      method: String(config.method ?? 'get').toLowerCase(),
      params: config.params ?? null,
      data: config.data ?? null,
    };
    state.requests.push(request);

    // A real Axios adapter REJECTS for a status outside 2xx; the rejection
    // carries the response body on `error.response`.
    const respond = (status, body) => {
      if (status >= 400) {
        const error = new Error(`Request failed with status code ${status}`);
        error.response = { status, data: body, statusText: 'Error', headers: {}, config };
        error.config = config;
        throw error;
      }
      return {
        data: body,
        status,
        statusText: 'OK',
        headers: {},
        config,
        request: {},
      };
    };

    if (request.method === 'post' && request.url.endsWith('/restore')) {
      if (state.onRestore) return state.onRestore(request, respond);
      const id = Number(request.url.split('/')[2]);
      const row = state.rows.find((item) => item.id === id);
      if (!row) return respond(404, { ok: false, error: { message: 'Expense not found' } });
      row.deletedAt = null;
      return respond(200, { ok: true, expense: row });
    }

    if (request.method === 'get' && request.url === '/expenses') {
      if (state.onList) return state.onList(request, respond);
      return respond(200, buildListBody(request, state.rows));
    }

    return respond(404, { ok: false, error: { message: `Route not found: ${request.method} ${request.url}` } });
  };

  state.restore = () => { client.defaults.adapter = previousAdapter; };
  return state;
}

/** The body the real backend answers a list request with. */
export function buildListBody(request, rows) {
  const params = request.params ?? {};
  const limit = Number(params.limit ?? 20);
  const page = Number(params.page ?? 1);
  const mode = String(params.includeDeleted ?? '').trim().toLowerCase();

  const matching = rows.filter((row) => {
    if (mode === 'only') {
      if (!row.deletedAt) return false;
    } else if (mode !== 'true') {
      if (row.deletedAt) return false;
    }
    if (params.expenseName && !String(row.expenseName ?? '').toLowerCase().includes(String(params.expenseName).toLowerCase())) {
      return false;
    }
    if (params.from) {
      const from = new Date(`${params.from}T00:00:00.000Z`).getTime();
      if (new Date(row.date).getTime() < from) return false;
    }
    if (params.to) {
      const to = new Date(`${params.to}T23:59:59.999Z`).getTime();
      if (new Date(row.date).getTime() > to) return false;
    }
    return true;
  });

  const total = matching.length;
  const start = (page - 1) * limit;
  const items = matching.slice(start, start + limit);

  // The backend groups the cumulative totals over the rows of the same query.
  const totals = new Map();
  for (const row of matching) {
    const key = row.expenseName ? row.expenseName.toLowerCase() : 'uncategorized';
    const current = totals.get(key) ?? { expenseName: row.expenseName ?? 'Uncategorized', total: 0 };
    current.total += Number(row.amount ?? 0);
    totals.set(key, current);
  }

  return {
    ok: true,
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    cumulativeTotals: [...totals.values()].sort((a, b) => b.total - a.total),
  };
}

/** Build an expense row for the stub. */
export function makeExpense(overrides = {}) {
  return {
    id: 1,
    date: '2026-11-01T00:00:00.000Z',
    category: 'RENT',
    expenseName: 'Office Rent',
    description: 'Monthly rent',
    amount: 100,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export default { installExpenseApiStub, buildListBody, makeExpense };
