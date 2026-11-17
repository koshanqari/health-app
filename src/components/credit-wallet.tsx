"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CreditDetails, PublicCreditDetails, PublicCreditStatus } from "@/lib/credits";

const amount = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function CreditWallet({ status, target, label, onStatus, onChanged }: {
  status?: PublicCreditStatus; target?: { id: string; name: string; email: string }; label?: string;
  onStatus?: (status: PublicCreditStatus) => void; onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="text-button credit-balance" aria-label={target ? `Manage credits: ${target.email}` : "View AI credits"} onClick={() => setOpen(true)}>
      {label ?? (status ? `Credits remaining: ${amount(status.available)}` : "Credits remaining: …")}
    </button>
    {open && <WalletDialog target={target} onClose={() => setOpen(false)} onLoaded={onStatus} onChanged={onChanged} />}
  </>;
}
function WalletDialog({ target, onClose, onLoaded, onChanged }: {
  target?: { id: string; name: string; email: string }; onClose: () => void; onLoaded?: (status: PublicCreditStatus) => void; onChanged?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [data, setData] = useState<CreditDetails | PublicCreditDetails | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [contact, setContact] = useState(false), [action, setAction] = useState("topup"), [revision, setRevision] = useState(0);
  const retry = useRef<{ body: string; requestId: string } | null>(null);
  const endpoint = "/api/credits" + (target ? "?userId=" + encodeURIComponent(target.id) : "");
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.message || "We couldn’t load credits.");
      if (!controller.signal.aborted) { setData(body); onLoaded?.(body); }
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "We couldn’t load credits."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, revision]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!target || busy) return;
    const element = event.currentTarget, form = new FormData(element);
    const input = { userId: target.id, action, reason: String(form.get("reason") || ""), ...(action === "pricing" ? { multiplier: Number(form.get("multiplier")) } : { amount: Number(form.get("amount")), ...(action === "topup" && String(form.get("paid") || "").trim() ? { amountPaid: Number(form.get("paid")) } : {}) }) };
    const body = JSON.stringify(input);
    if (!retry.current || retry.current.body !== body) retry.current = { body, requestId: crypto.randomUUID() };
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/credits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, requestId: retry.current.requestId }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || "We couldn’t update credits.");
      for (const name of ["amount", "paid", "reason"]) {
        const input = element.elements.namedItem(name); if (input instanceof HTMLInputElement) input.value = "";
      }
      retry.current = null; setNotice(action === "pricing" ? "Rate updated for future requests." : "Credits added."); setRevision(value => value + 1); onChanged?.();
    } catch (error) { setError(error instanceof Error ? error.message : "We couldn’t confirm the update. Retry to check it safely."); }
    finally { setBusy(false); }
  }
  const adminData = target && data ? data as CreditDetails : null;
  return <dialog ref={dialog} className="food-dialog credit-dialog" aria-labelledby={id + "-title"} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="food-form-heading"><h2 id={id + "-title"}>{target ? `Credits · ${target.name}` : "AI credits"}</h2><button className="dialog-close" type="button" aria-label="Close credits" disabled={busy} onClick={onClose}>×</button></div>
    <div className="credit-dialog-body">
      {loading && <p role="status">Loading credits…</p>}
      {data && <>
        <p className="credit-total"><strong>{amount(data.available)}</strong><span>credits remaining</span></p>
        <p className="credit-estimate">About <strong>{data.estimatedReplies}</strong> replies remaining</p>
        {adminData && <><p className="credit-help">An estimate from recent AI usage, or a typical reply for a new account. Photos and longer conversations can use more. Daily and shared AI limits still apply.</p>
        <dl className="credit-facts"><div><dt>Current rate</dt><dd>{adminData.multiplier.toFixed(2)}×</dd></div><div><dt>Typical reply estimate</dt><dd>{amount(adminData.estimatedReplyCost)} credits</dd></div><div><dt>Maximum per reply</dt><dd>{amount(adminData.maximumReplyCharge)} credits</dd></div>{adminData.held > 0 && <div><dt>Reserved for pending replies</dt><dd>{amount(adminData.held)} credits</dd></div>}</dl>
        <p className="credit-help">1 credit = ₹1. Up to {amount(adminData.maximumReplyCharge)} credits are temporarily reserved when you send. Unused credits return after the reply; failed replies aren’t charged.</p></>}
        {!target && <><button className="primary-button" type="button" onClick={() => setContact(true)}>Add credits</button>{contact && <p className="credit-contact">For more credits, please contact <a href="https://in.linkedin.com/in/koshanqari" target="_blank" rel="noopener noreferrer">Koshan Qari on LinkedIn ↗</a>.</p>}</>}
        {adminData && <form className="credit-admin-form" aria-label="Manage AI credits" onSubmit={submit}>
          <fieldset disabled={busy || loading} className="admin-create-fields">
            <div className="field"><label htmlFor={id + "-action"}>Action</label><select id={id + "-action"} value={action} onChange={event => { setAction(event.target.value); setNotice(""); }}><option value="topup">Add credits</option><option value="refund">Refund credits</option><option value="pricing">Change multiplier</option></select></div>
            {action === "pricing" ? <div className="field"><label htmlFor={id + "-rate"}>Multiplier</label><input key={adminData.multiplier} id={id + "-rate"} name="multiplier" type="number" min=".1" max="10" step=".01" required defaultValue={adminData.multiplier} /><p className="field-help">From 0.10× to 10×. Pending replies keep their original rate.</p></div> : <div className="field"><label htmlFor={id + "-amount"}>Credits to add</label><input id={id + "-amount"} name="amount" type="number" min=".01" max="100000" step=".01" required /></div>}
            {action === "topup" && <div className="field"><label htmlFor={id + "-paid"}>Money received (₹, optional)</label><input id={id + "-paid"} name="paid" type="number" min="0" max="100000" step=".01" /></div>}
            <div className="field"><label htmlFor={id + "-reason"}>Reason or payment reference</label><input id={id + "-reason"} name="reason" required maxLength={250} /></div>
            <button className="primary-button" type="submit">{busy ? "Saving…" : action === "pricing" ? "Save multiplier" : "Confirm credits"}</button>
          </fieldset>
        </form>}
        {notice && <p className="journal-notice" role="status">{notice}</p>}
        <h3 className="credit-history-title">Credit history</h3>
        <ul className="credit-history">{data.transactions.map(item => <li key={item.id}><div><strong>{item.reason}</strong><small>{new Date(item.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}{target && "actorName" in item && item.actorName ? ` · ${item.actorName}` : ""}{target && "multiplier" in item && item.multiplier !== null ? ` · ${item.multiplier.toFixed(2)}×` : ""}{target && "amountPaid" in item && item.amountPaid !== null ? ` · ₹${amount(item.amountPaid)} received` : ""}</small></div><span>{item.amount > 0 ? "+" : ""}{amount(item.amount)}</span></li>)}</ul>
        {target && <p className="credit-help">Showing the latest 30 transactions. Credits do not expire.</p>}
      </>}
      {error && <div className="form-error" role="alert"><p>{error}</p>{!data && <button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}>Try again</button>}</div>}
    </div>
  </dialog>;
}
