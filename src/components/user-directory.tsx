"use client";

import { useState } from "react";
export type DirectoryUser = { id: string; name: string; email: string; role: string; createdAt: string };
type SortKey = "name" | "email" | "role" | "createdAt";
const columns: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email address" },
  { key: "role", label: "Role" },
  { key: "createdAt", label: "Joined" },
];
const pageSize = 20;
const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function UserDirectory({ users }: { users: DirectoryUser[] }) {
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
    <div className="directory-heading"><div><h2 id="directory-title">Your community</h2><p>The latest {users.length === 100 ? "100 " : ""}accounts in Daywell.</p></div></div>
    <div className="directory-toolbar">
      <label className="search-field"><span className="sr-only">Search accounts</span><input type="search" aria-label="Search accounts" placeholder="Search by name or email" value={query} onChange={event => { setQuery(event.currentTarget.value); setPage(1); }} /></label>
      <div className="directory-filters" aria-label="Filter accounts">
        {[{ value: "all", label: "All accounts" }, { value: "user", label: "Members" }, { value: "admin", label: "Administrators" }].map(item => <button type="button" className={filter === item.value ? "filter-button selected" : "filter-button"} key={item.value} aria-pressed={filter === item.value} onClick={() => { setFilter(item.value); setPage(1); }}>{item.label}</button>)}
      </div>
    </div>
    <div className="table-scroll"><table className="account-table">
      <caption className="sr-only">Daywell accounts</caption>
      <thead><tr>{columns.map(column => <th scope="col" key={column.key} aria-sort={sort.key === column.key ? sort.ascending ? "ascending" : "descending" : "none"}>
        <button type="button" className="sort-button" onClick={() => sortBy(column.key)}>{column.label}{sort.key === column.key && <span aria-hidden="true">{sort.ascending ? " ↑" : " ↓"}</span>}</button>
      </th>)}</tr></thead>
      <tbody>{visible.map(user => <tr key={user.id}>
        <td><div className="table-name"><span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span><span>{user.name}</span></div></td>
        <td>{user.email}</td>
        <td>{user.role === "admin" ? "Administrator" : "Member"}</td>
        <td>{dateFormat.format(new Date(user.createdAt))}</td>
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
  </section>;
}
