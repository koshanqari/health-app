"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronIcon } from "./app-header";
import { CreditWallet } from "./credit-wallet";
import { useRouter } from "next/navigation";
export type DirectoryUser = { id: string; name: string; email: string; role: string; createdAt: string; credits?: number; multiplier?: number };
type SortKey = "name" | "email" | "role" | "createdAt";
const columns: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email address" },
  { key: "role", label: "Role" },
  { key: "createdAt", label: "Joined" },
];
const pageSize = 20;
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function UserDirectory({ users, currentUserId }: { users: DirectoryUser[]; currentUserId?: string }) {
  const router = useRouter();
  const [action, setAction] = useState<{ type: "create" } | { type: "role"; user: DirectoryUser } | null>(null);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: "createdAt", ascending: false });
  const filtered = users
    .filter(user => (filter === "all" || user.role === filter) && `${user.name} ${user.email}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a[sort.key].localeCompare(b[sort.key]) * (sort.ascending ? 1 : -1));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);

  function sortBy(key: SortKey) {
    setSort(current => ({ key, ascending: current.key === key ? !current.ascending : true }));
    setPage(1);
  }

  return <section className="directory" aria-labelledby="directory-title">
    <div className="directory-heading"><div><h2 id="directory-title">Your community</h2><p>The latest {users.length === 100 ? "100 " : ""}accounts in Daywell.</p></div><button type="button" className="primary-button" onClick={() => { setNotice(""); setAction({ type: "create" }); }}>Create administrator</button></div>
    {notice && <p className="journal-notice" role="status">{notice}</p>}
    <div className="directory-toolbar">
      <label className="search-field"><span className="sr-only">Search accounts</span><input type="search" aria-label="Search accounts" placeholder="Search by name or email" value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(1); }} /></label>
      <div className="directory-filters" aria-label="Filter accounts">
        {[{ value: "all", label: "All accounts" }, { value: "user", label: "Members" }, { value: "admin", label: "Administrators" }].map(item => <button type="button" className={filter === item.value ? "filter-button selected" : "filter-button"} key={item.value} aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setPage(1); }}>{item.label}</button>)}
      </div>
    </div>
    <div className="table-scroll"><table className="account-table">
      <caption className="sr-only">Daywell accounts</caption>
      <thead><tr>{columns.map(column => <th scope="col" key={column.key} aria-sort={sort.key === column.key ? sort.ascending ? "ascending" : "descending" : "none"}>
        <button type="button" className="sort-button" onClick={() => sortBy(column.key)}>{column.label}{sort.key === column.key && <ChevronIcon direction={sort.ascending ? "up" : "down"} />}</button>
      </th>)}<th scope="col">AI credits</th><th scope="col">Multiplier</th><th scope="col">Access</th></tr></thead>
      <tbody>{visible.map(user => <tr key={user.id}>
        <td><div className="table-name"><span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span><span>{user.name}</span></div></td>
        <td>{user.email}</td>
        <td>{user.role === "admin" ? "Administrator" : "Member"}</td>
        <td>{dateFormat.format(new Date(user.createdAt))}</td>
        <td><CreditWallet target={user} label={(user.credits ?? 0).toFixed(2)} onChanged={() => router.refresh()} /></td>
        <td><CreditWallet target={user} adminMode="pricing" label={`${(user.multiplier ?? 3.33).toFixed(2)}×`} onChanged={() => router.refresh()} /></td>
        <td><button type="button" className="text-button" aria-label={`${user.role === "admin" ? "Make member" : "Make administrator"}: ${user.email}`} onClick={() => { setNotice(""); setAction({ type: "role", user }); }}>{user.role === "admin" ? "Make member" : "Make administrator"}</button>{user.id === currentUserId && <small className="admin-self">Your account</small>}</td>
      </tr>)}</tbody>
    </table></div>
    {filtered.length === 0 && <div className="directory-empty"><p>No accounts match this search.</p><button type="button" className="text-button" onClick={() => { setQuery(""); setFilter("all"); setPage(1); }}>Clear filters</button></div>}
    <div className="directory-bottom">
      <span>{filtered.length} {filtered.length === 1 ? "account" : "accounts"}</span>
      {pageCount > 1 && <nav className="directory-pagination" aria-label="Account pages">
        <button type="button" className="text-button" disabled={page === 1} onClick={() => setPage(current => current - 1)}>Previous</button>
        <span aria-live="polite">Page {page} of {pageCount}</span>
        <button type="button" className="text-button" disabled={page === pageCount} onClick={() => setPage(current => current + 1)}>Next</button>
      </nav>}
    </div>
    {action && <AdminAction action={action} onClose={() => setAction(null)} onSaved={() => { setNotice(action.type === "create" ? "Administrator created. They can sign in at /admin." : "Role updated. This account needs to sign in again."); setAction(null); router.refresh(); }} />}
  </section>;
}

function AdminAction({ action, onClose, onSaved }: {
  action: { type: "create" } | { type: "role"; user: DirectoryUser }; onClose: () => void; onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const create = action.type === "create";
  const title = create ? "Create administrator" : action.user.role === "admin" ? "Make member" : "Make administrator";
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const data = new FormData(event.currentTarget);
    const body = action.type === "create"
      ? { name: String(data.get("name") || ""), email: String(data.get("email") || ""), password: String(data.get("password") || "") }
      : { id: action.user.id, role: action.user.role === "admin" ? "user" : "admin" };
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/admin/users", { method: create ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "We couldn’t update this account.");
      onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : "We couldn’t confirm the change. Refresh before trying again."); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="food-dialog" aria-labelledby="admin-action-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="food-form-heading"><h2 id="admin-action-title">{title}</h2><button type="button" className="dialog-close" aria-label="Close account action" disabled={busy} onClick={onClose}>×</button></div>
    <form onSubmit={submit}>
      <div className="food-form-body">
        {create ? <fieldset className="admin-create-fields" disabled={busy}>
          <div className="field"><label htmlFor="admin-name">Name</label><input id="admin-name" name="name" autoComplete="off" required maxLength={80} autoFocus /></div>
          <div className="field"><label htmlFor="admin-email">Email address</label><input id="admin-email" name="email" type="email" autoComplete="off" required maxLength={254} /></div>
          <div className="field"><label htmlFor="admin-password">Initial password</label><input id="admin-password" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></div>
          <p className="field-help">Use 12–128 characters. Share these sign-in details privately; no invitation email is sent.</p>
        </fieldset> : <p>Change {action.user.name} ({action.user.email}) to {action.user.role === "admin" ? "a member" : "an administrator"}? They’ll need to sign in again.{action.user.role !== "admin" && " Administrators can view the account directory and manage administrator access."}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <div className="food-form-actions"><button type="button" className="cancel-food-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving…" : create ? "Create admin" : "Confirm change"}</button></div>
    </form>
  </dialog>;
}
