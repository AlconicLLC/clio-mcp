import http from "http";

function buildState(options) {
  const matterCount = options.matterCount ?? 6;
  const state = {
    matters: [],
    contacts: [],
    users: [{ id: 1, name: "Test User", email: "user@example.invalid", enabled: true, subscription_type: "Attorney", initials: "TU", created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" }],
    folders: [{ id: 1, name: "Root", parent: null, matter: null, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" }],
    documents: [],
    notes: [],
    tasks: [],
    calendar: [],
    activities: [],
    contents: new Map(),
  };
  let folderId = 100;
  let docId = 5000;
  for (let i = 1; i <= matterCount; i++) {
    const updated = i % 2 === 0 ? "2026-03-01T00:00:00Z" : "2025-06-01T00:00:00Z";
    state.matters.push({
      id: i,
      display_number: `2025-${String(i).padStart(4, "0")}`,
      description: `Synthetic matter ${i}`,
      status: "Open",
      client: { id: 100 + i, name: `Client ${i}` },
      practice_area: { id: 1, name: "General" },
      matter_stage: { id: 1, name: "Stage" },
      responsible_attorney: { id: 1, name: "Test User" },
      originating_attorney: { id: 1, name: "Test User" },
      responsible_staff: null,
      open_date: "2025-02-01",
      close_date: null,
      billable: true,
      created_at: "2025-02-01T00:00:00Z",
      updated_at: updated,
      custom_field_values: [],
    });
    const rootId = folderId++;
    const subId = folderId++;
    state.folders.push(
      { id: rootId, name: `Matter ${i}`, parent: { id: 1, type: "Folder" }, matter: { id: i, display_number: `2025-${String(i).padStart(4, "0")}` }, created_at: "2025-02-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z" },
      { id: subId, name: "Pleadings", parent: { id: rootId, type: "Folder" }, matter: { id: i, display_number: `2025-${String(i).padStart(4, "0")}` }, created_at: "2025-02-01T00:00:00Z", updated_at: "2025-02-01T00:00:00Z" }
    );
    const names = options.lightDocs
      ? []
      : [
          ["Engagement letter.pdf", rootId],
          ["CON.txt", subId],
          ["Motion: draft?.docx", subId],
        ];
    for (const [name, parent] of names) {
      const id = docId++;
      const uuid = `uuid-${id}-1`;
      const body = `synthetic-content-${id}-${"x".repeat(id % 40)}`;
      state.contents.set(uuid, body);
      state.documents.push({
        id,
        name,
        content_type: "application/octet-stream",
        size: Buffer.byteLength(body),
        created_at: "2025-02-02T00:00:00Z",
        updated_at: updated,
        matter: { id: i, display_number: `2025-${String(i).padStart(4, "0")}` },
        parent: { id: parent, type: "Folder" },
        latest_document_version: { uuid, size: Buffer.byteLength(body) },
      });
    }
    state.documents.push({
      id: docId++,
      name: "Empty placeholder",
      content_type: "application/octet-stream",
      size: 0,
      created_at: "2025-02-02T00:00:00Z",
      updated_at: updated,
      matter: { id: i, display_number: `2025-${String(i).padStart(4, "0")}` },
      parent: { id: rootId, type: "Folder" },
    });
    state.tasks.push({ id: 300 + i, name: `Task ${i}`, priority: "Normal", due_at: "2026-01-01", status: "pending", assignee: { id: 1, name: "Test User" }, matter: { id: i, display_number: `2025-${String(i).padStart(4, "0")}` }, reminders: [], created_at: "2025-03-01T00:00:00Z", updated_at: updated });
    state.notes.push({ id: 400 + i, subject: `Note ${i}`, detail: "=SUM(1+1)", detail_text_type: "plain", date: "2025-03-01", type: "Matter", matter: { id: i, display_number: `2025-${String(i).padStart(4, "0")}` }, contact: null, author: { id: 1, name: "Test User" }, created_at: "2025-03-01T00:00:00Z", updated_at: updated, _kind: "matter" });
  }
  for (let i = 1; i <= 4; i++) {
    state.contacts.push({ id: 100 + i, name: `Contact ${i}`, first_name: "C", last_name: String(i), title: null, type: "Person", company: null, email_addresses: [{ address: `c${i}@example.invalid`, name: "Work" }], phone_numbers: [{ number: "+1 555 0100", name: "Work" }], addresses: [], created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z", custom_field_values: [] });
  }
  state.notes.push({ id: 450, subject: "Contact note", detail: "plain", detail_text_type: "plain", date: "2025-03-02", type: "Contact", matter: null, contact: { id: 101, name: "Contact 1" }, author: { id: 1, name: "Test User" }, created_at: "2025-03-02T00:00:00Z", updated_at: "2025-03-02T00:00:00Z", _kind: "contact" });
  state.calendar.push(
    { id: 501, summary: "Hearing", description: null, start_at: "2024-05-01T09:00:00Z", end_at: "2024-05-01T10:00:00Z", matter: { id: 1, display_number: "2025-0001" }, attendees: [], created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
    { id: 502, summary: "Deadline", description: null, start_at: "2026-02-01T09:00:00Z", end_at: "2026-02-01T10:00:00Z", matter: null, attendees: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-03-01T00:00:00Z" }
  );
  state.activities.push(
    { id: 601, type: "TimeEntry", date: "2025-04-01", quantity_in_hours: 1.5, price: 100, total: 150, note: "Work", matter: { id: 1, display_number: "2025-0001" }, user: { id: 1, name: "Test User" }, created_at: "2025-04-01T00:00:00Z", updated_at: "2025-04-01T00:00:00Z" },
    { id: 602, type: "ExpenseEntry", date: "2025-04-02", price: -25.5, total: -25.5, note: "Filing fee", quantity: 1, expense_category: { id: 1, name: "Fees" }, matter: { id: 1, display_number: "2025-0001" }, user: { id: 1, name: "Test User" }, created_at: "2025-04-02T00:00:00Z", updated_at: "2025-04-02T00:00:00Z" }
  );
  for (let i = 0; i < (options.unfiledDocs ?? 0); i++) {
    const id = docId++;
    state.documents.push({ id, name: `Loose ${i}.txt`, content_type: "text/plain", size: 0, created_at: "2025-02-02T00:00:00Z", updated_at: "2025-02-02T00:00:00Z", matter: null, parent: { id: 1, type: "Folder" } });
  }
  return state;
}

function matches(rule, req) {
  return typeof rule.match === "string" ? req.includes(rule.match) : rule.match.test(req);
}

export async function startFakeClio(options = {}) {
  const state = buildState(options);
  const stats = {
    requests: [],
    storage: [],
    nonGet: 0,
    maxConcurrentDownloads: 0,
    downloadsStarted: 0,
  };
  const failures = (options.failures ?? []).map((f) => ({ ...f, remaining: f.times ?? 1 }));
  const forbidden = new Set(options.forbidden ?? []);
  const rejectFields = options.rejectFields ?? [];
  let concurrent = 0;

  const storage = http.createServer((req, res) => {
    stats.storage.push({ path: req.url, hasAuthorization: Boolean(req.headers.authorization) });
    const uuid = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
    const body = state.contents.get(uuid);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    concurrent++;
    stats.downloadsStarted++;
    stats.maxConcurrentDownloads = Math.max(stats.maxConcurrentDownloads, concurrent);
    const finish = () => {
      concurrent--;
    };
    res.on("close", finish);
    const send = () => {
      const failure = failures.find((f) => f.storage && f.remaining > 0 && matches(f, req.url));
      if (failure) {
        failure.remaining--;
        res.writeHead(failure.status).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    if (options.downloadDelayMs) setTimeout(send, options.downloadDelayMs);
    else send();
  });
  await new Promise((resolve) => storage.listen(0, "127.0.0.1", resolve));
  const storagePort = storage.address().port;

  const api = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const record = { method: req.method, path: url.pathname, query: url.search, hasAuthorization: Boolean(req.headers.authorization) };
    stats.requests.push(record);
    options.onRequest?.(record, stats);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (req.method !== "GET") {
      stats.nonGet++;
      return send(405, { error: { message: "writes are not allowed" } });
    }
    const failure = failures.find((f) => !f.storage && f.remaining > 0 && matches(f, `${url.pathname}${url.search}`));
    if (failure) {
      failure.remaining--;
      return send(failure.status, { error: { message: "injected failure" } }, failure.headers ?? {});
    }
    const fields = url.searchParams.get("fields") ?? "";
    for (const bad of rejectFields) {
      if (fields.includes(bad)) return send(400, { error: { type: "InvalidFields", message: `${bad} is not a valid field` } });
    }
    const since = url.searchParams.get("updated_since");
    const sinceMs = since ? Date.parse(since) : null;
    const filterSince = (items) => (sinceMs === null ? items : items.filter((i) => Date.parse(i.updated_at) > sinceMs));
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const offset = Number(url.searchParams.get("page_token") ?? 0);
    const apiBase = `http://127.0.0.1:${api.address().port}/api/v4`;
    const paged = (items) => {
      const slice = items.slice(offset, offset + limit);
      const next = offset + limit < items.length ? `${apiBase}${url.pathname.replace("/api/v4", "")}?page_token=${offset + limit}&limit=${limit}` : undefined;
      return send(200, { data: slice, meta: { records: options.omitRecords ? undefined : items.length, paging: next ? { next } : {} } });
    };

    const pathName = url.pathname.replace(/^\/api\/v4/, "");
    if (forbidden.has(pathName)) return send(403, { error: { message: "User is forbidden from taking that action" } });

    switch (pathName) {
      case "/matters.json":
        return paged(filterSince(state.matters));
      case "/contacts.json":
        return paged(filterSince(state.contacts));
      case "/users.json":
        return paged(filterSince(state.users));
      case "/practice_areas.json":
        return paged([{ id: 1, name: "General", code: "GEN" }]);
      case "/matter_stages.json":
        return paged([{ id: 1, name: "Stage", practice_area: { id: 1 } }]);
      case "/custom_fields.json":
        return paged([]);
      case "/relationships.json":
        return paged(filterSince([{ id: 701, description: "Co-counsel", contact: { id: 101, name: "Contact 1", type: "Person" }, matter: { id: 1, display_number: "2025-0001" }, created_at: "2025-01-01T00:00:00Z", updated_at: "2025-01-01T00:00:00Z" }]));
      case "/tasks.json":
        return paged(filterSince(state.tasks));
      case "/calendar_entries.json": {
        const from = Date.parse(url.searchParams.get("from") ?? "1970-01-01T00:00:00Z");
        const to = Date.parse(url.searchParams.get("to") ?? "2100-01-01T00:00:00Z");
        return paged(filterSince(state.calendar).filter((c) => Date.parse(c.start_at) >= from && Date.parse(c.start_at) <= to));
      }
      case "/notes.json": {
        const type = url.searchParams.get("type");
        if (type !== "matter" && type !== "contact") return send(400, { error: { message: "type is required" } });
        return paged(filterSince(state.notes.filter((n) => n._kind === type)));
      }
      case "/activities.json": {
        const type = url.searchParams.get("type");
        return paged(filterSince(state.activities.filter((a) => a.type === type)));
      }
      case "/bills.json":
        return paged([]);
      case "/folders.json":
        return paged(state.folders);
      case "/documents.json": {
        const matterId = url.searchParams.get("matter_id");
        const docs = filterSince(state.documents).filter((d) => matterId === null || (d.matter && String(d.matter.id) === matterId));
        return paged(docs);
      }
      default: {
        const download = /^\/documents\/(\d+)\/download$/.exec(pathName);
        if (download) {
          const doc = state.documents.find((d) => String(d.id) === download[1]);
          const uuid = url.searchParams.get("version_uuid") ?? doc?.latest_document_version?.uuid;
          if (!doc || !uuid || !state.contents.has(uuid)) return send(404, { error: { message: "not found" } });
          res.writeHead(303, { location: `http://127.0.0.1:${storagePort}/blob/${encodeURIComponent(uuid)}` });
          return res.end();
        }
        const versions = /^\/documents\/(\d+)\/versions\.json$/.exec(pathName);
        if (versions) {
          const doc = state.documents.find((d) => String(d.id) === versions[1]);
          return paged(doc?.latest_document_version ? [{ id: doc.id * 10, uuid: doc.latest_document_version.uuid, size: doc.latest_document_version.size, created_at: doc.created_at }] : []);
        }
        return send(404, { error: { message: "not found" } });
      }
    }
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));

  return {
    apiBase: `http://127.0.0.1:${api.address().port}/api/v4`,
    state,
    stats,
    stop: () =>
      Promise.all([
        new Promise((resolve) => {
          api.closeAllConnections?.();
          api.close(() => resolve());
        }),
        new Promise((resolve) => {
          storage.closeAllConnections?.();
          storage.close(() => resolve());
        }),
      ]).then(() => undefined),
  };
}
