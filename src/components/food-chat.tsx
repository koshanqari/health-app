"use client";

import { ActivityGoalForm, ActivityForm } from "./activity-journal";
import { ProfileProposal } from "./profile-proposal";
import type { ProfileChange } from "@/lib/profile";
import { useMemberFetch, useViewingAs } from "./member-view";

import Link from "next/link";
import { memo, useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { UpdateGuard } from "./app-updates";
import { CreditWallet } from "./credit-wallet";
import { GoalForm } from "./food-goals";
import { goalNutrients } from "@/lib/food-goals";
import { FoodForm } from "./food-journal";
import { foodRequestId, prepareFoodPhoto } from "@/lib/food-photo-client";
import { MAX_CHAT_PHOTOS, MAX_CHAT_PHOTO_BYTES, type FoodChatPhotoMode, macroCalorieEstimate, type FoodChatActivityGoalDraft, type FoodChatActivityDraft, type FoodChatGoalDraft, type FoodChatDraft, type FoodChatMessage, type FoodChatState, type FoodInput } from "@/lib/food";

const numbers = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });
const number = (value: number) => numbers.format(value);
type Attachment = { id: string; file: File; url: string };
function ComposerIcon({ camera = false }: { camera?: boolean }) {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{camera ? <><path d="M4 6h3l2-3h6l2 3h3a1 1 0 0 1 1 1v12H3V7a1 1 0 0 1 1-1Z" /><circle cx="12" cy="12" r="4" /></> : <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1" /><path d="m3 17 5-5 4 4 3-3 6 6" /></>}</svg>;
}

export function FoodChat({ active, starter }: { active: boolean; starter?: { id: number; prompt: string } | null }) {
  const fetch = useMemberFetch();
  const viewingAs = useViewingAs();
  const [state, setState] = useState<FoodChatState | null>(null);
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<Attachment[]>([]);
  const [photoMode, setPhotoMode] = useState<FoodChatPhotoMode>("auto");
  const attachments = useRef<Attachment[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [optimistic, setOptimistic] = useState<FoodChatMessage | null>(null);
  const [activityGoalReview, setActivityGoalReview] = useState<FoodChatActivityGoalDraft | null>(null);
  const [activityReview, setActivityReview] = useState<FoodChatActivityDraft | null>(null);
  const [goalReview, setGoalReview] = useState<FoodChatGoalDraft | null>(null);
  const usedStarter = useRef<number | null>(null);
  const [review, setReview] = useState<FoodChatDraft | null>(null);
  const [notice, setNotice] = useState("");
  const initial = useRef(false), selection = useRef(0);
  const request = useRef<AbortController | null>(null);
  const retry = useRef<{ id: string; text: string; files: File[]; photoMode: FoodChatPhotoMode } | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const scrollToEnd = useRef(true);
  const refreshedAt = useRef(0);

  function apply(next: FoodChatState) {
    refreshedAt.current = Date.now();
    setState(previous => previous && next.version < previous.version ? previous : next);
  }
  async function refresh(signal?: AbortSignal) {
    const response = await fetch("/api/food/chat", { cache: "no-store", signal });
    const next = await response.json();
    if (!response.ok) throw new Error(next.message || "We couldn’t load the conversation.");
    apply(next); return next as FoodChatState;
  }
  function replacePhotos(next: Attachment[]) {
    for (const photo of attachments.current) if (!next.some(item => item.id === photo.id)) URL.revokeObjectURL(photo.url);
    attachments.current = next; setPhotos(next);
  }
  function clearComposer() { setText(""); replacePhotos([]); setPhotoMode("auto"); setOptimistic(null); retry.current = null; }
  async function load(fresh = !state) {
    setLoading(true); setError("");
    try {
      if (fresh && !viewingAs) {
        const response = await fetch("/api/food/chat", { method: "DELETE" });
        const next = await response.json();
        if (!response.ok) throw new Error(next.message || "We couldn’t start a new chat.");
        selection.current++; setPreparing(false); clearComposer(); setReview(null); setGoalReview(null); setActivityReview(null); setActivityGoalReview(null); setNotice(""); scrollToEnd.current = true; apply(next);
      } else await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "We couldn’t load the conversation."); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (active && !initial.current) { initial.current = true; void load(true); } }, [active]);
  useEffect(() => { if (!active) { setReview(null); setGoalReview(null); setActivityReview(null); setActivityGoalReview(null); } }, [active]);
  useEffect(() => {
    if (!active || loading || busy || !state || state.pending || !starter || usedStarter.current === starter.id) return;
    usedStarter.current = starter.id;
    // This explicit shortcut replaces only composer contents, not the active conversation.
    selection.current++; setPreparing(false); clearComposer(); setText(starter.prompt); setNotice("");
    input.current?.focus();
  }, [active, loading, busy, state, starter]);
  useEffect(() => () => { request.current?.abort(); selection.current++; for (const photo of attachments.current) URL.revokeObjectURL(photo.url); }, []);
  useEffect(() => {
    if (active && scrollToEnd.current && thread.current) thread.current.scrollTop = (state?.messages.length || optimistic) ? thread.current.scrollHeight : 0;
  }, [active, state?.messages.length, optimistic, busy]);
  useEffect(() => {
    if (!state?.pending || busy) return;
    const timer = setInterval(() => {
      void refresh().then(next => {
        if (!next.pending && retry.current && next.messages.some(message => message.role === "assistant" && message.requestId === retry.current!.id)) { clearComposer(); setError(""); }
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [state?.pending, busy]);

  useEffect(() => {
    const guard = (event: Event) => {
      const detail = (event as CustomEvent<UpdateGuard>).detail;
      detail.busy ||= busy || loading || preparing || !!state?.pending;
      detail.dirty ||= !!text.trim() || photos.length > 0 || !!state?.draft || !!state?.goalDraft || !!state?.profileDraft || !!state?.activityGoalDraft || !!activityGoalReview || !!state?.activityDraft || !!activityReview || !!review || !!goalReview;
    };
    window.addEventListener("daywell-update-guard", guard);
    return () => window.removeEventListener("daywell-update-guard", guard);
  }, [busy, loading, preparing, state?.pending, state?.draft, state?.goalDraft, state?.profileDraft, state?.activityGoalDraft, activityGoalReview, state?.activityDraft, activityReview, text, photos.length, review, goalReview]);

  useEffect(() => {
    if (!active || !state || busy || loading || preparing || state.pending) return;
    const controller = new AbortController();
    let inFlight = false;
    async function check(force = false) {
      const age = Date.now() - refreshedAt.current;
      if (controller.signal.aborted || inFlight || document.visibilityState !== "visible" || !navigator.onLine || age < (force ? 2000 : 30_000)) return;
      inFlight = true;
      try { await refresh(controller.signal); } catch { /* Keep the composer/photos; retry on the next resume. */ }
      finally { inFlight = false; }
    }
    const resume = () => { void check(true); };
    void check();
    const timer = setInterval(() => { void check(); }, 30_000);
    window.addEventListener("focus", resume); window.addEventListener("pageshow", resume); window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      controller.abort(); clearInterval(timer);
      window.removeEventListener("focus", resume); window.removeEventListener("pageshow", resume); window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [active, !!state, busy, loading, preparing, state?.pending]);

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
    if (!files.length || busy || loading || state?.pending || preparing) return;
    if (attachments.current.length + files.length > MAX_CHAT_PHOTOS) { setError(`Attach up to ${MAX_CHAT_PHOTOS} photos per message. Remove a photo before adding more.`); return; }
    const version = ++selection.current;
    setPreparing(true); setError("");
    try {
      const prepared: File[] = [];
      let total = attachments.current.reduce((bytes, photo) => bytes + photo.file.size, 0);
      // Decode sequentially to keep memory use modest on a phone.
      for (const file of files) {
        const photo = await prepareFoodPhoto(file);
        total += photo.size;
        if (total > MAX_CHAT_PHOTO_BYTES) throw new Error("Keep the resized photos under 3 MB combined. Try fewer photos.");
        prepared.push(photo);
      }
      if (version === selection.current) {
        retry.current = null;
        replacePhotos([...attachments.current, ...prepared.map(file => ({ id: foodRequestId(), file, url: URL.createObjectURL(file) }))]);
      }
    } catch (error) { if (version === selection.current) setError(error instanceof Error ? error.message : "Choose another photo."); }
    finally { if (version === selection.current) setPreparing(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!state || busy || loading || state.pending || preparing || (!text.trim() && !photos.length)) return;
    const mode = photos.length > 1 ? photoMode : "auto";
    const sameAttachments = retry.current?.files.length === photos.length && photos.every((photo, index) => retry.current!.files[index] === photo.file);
    const id = retry.current && retry.current.text === text.trim() && sameAttachments && retry.current.photoMode === mode ? retry.current.id : foodRequestId();
    retry.current = { id, text: text.trim(), files: photos.map(photo => photo.file), photoMode: mode };
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(""); setNotice(""); scrollToEnd.current = true;
    setOptimistic({ id, requestId: id, sequence: Number.MAX_SAFE_INTEGER, role: "user", content: text.trim() || (photos.length > 1 ? "Food photos" : "Food photo"), createdAt: new Date().toISOString(), payload: { state: "pending", hasPhoto: photos.length > 0, photoCount: photos.length, photoMode: mode } });
    const form = new FormData();
    form.set("requestId", id); form.set("version", String(state.version)); form.set("text", text.trim()); form.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone);
    for (const photo of photos) form.append("photos", photo.file);
    form.set("photoMode", mode);
    try {
      const response = await fetch("/api/food/chat", { method: "POST", body: form, signal: controller.signal });
      const next = await response.json();
      if (!response.ok) throw new Error(next.message || "We couldn’t get a reply. Try again.");
      apply(next); clearComposer();
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(error instanceof Error ? error.message : "The connection was interrupted. Your message is still here; retry when connected.");
      setOptimistic(current => current ? { ...current, payload: { ...current.payload, state: "failed" } } : null);
      try {
        const latest = await refresh();
        if (latest.messages.some(message => message.role === "assistant" && message.requestId === id)) { clearComposer(); setError(""); }
        else if (latest.messages.some(message => message.id === id)) setOptimistic(null);
      } catch { /* Keep the local message and attachment available for an explicit retry. */ }
    } finally { if (request.current === controller) { setBusy(false); request.current = null; } }
  }
  const waiting = busy || !!state?.pending;
  const creditLimited = !!state?.quota.credits && !state.quota.credits.canSend;
  const limited = creditLimited || !!state && (state.quota.remainingToday < 1 || state.quota.remainingBudgetUsd < .01);
  const canSend = !viewingAs && !!state?.quota.configured && !waiting && !loading && !preparing && !limited && (!!text.trim() || photos.length > 0);
  const saveProfileProposal = useCallback(async (draftId: string, profile: ProfileChange) => {
    if (viewingAs) throw new Error("Viewing as a user is read-only.");
    setBusy(true);
    try {
      const response = await fetch("/api/food/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId, profile }) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.message || "We couldn’t save your profile.");
      apply(next); window.dispatchEvent(new Event("profile-saved"));
    } finally { setBusy(false); }
  }, [fetch, viewingAs]);
  const messages = state?.messages ?? [];
  const visibleOptimistic = optimistic && !messages.some(message => message.id === optimistic.id);

  return <section className="food-chat" aria-label="Kay">
    <div className="chat-toolbar"><CreditWallet status={state?.quota.credits} onStatus={credits => setState(current => current ? { ...current, quota: { ...current.quota, credits } } : current)} /><button className="text-button" type="button" onClick={() => void load(true)} disabled={!!viewingAs || loading || busy || !state || !!state?.pending}>New chat</button></div>
    <div className={photos.length ? "chat-layout has-photos" : "chat-layout"}>
      <div className="chat-thread" ref={thread} role="log" aria-label="Conversation with Kay" aria-live="polite" onScroll={() => { const element = thread.current; if (element) scrollToEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
        {loading && <p className="chat-status" role="status">Loading your conversation…</p>}
        {state && messages.length === 0 && !visibleOptimistic && <div className="chat-empty"><h2>Hi, I’m Kay.</h2><p>Start with a message or a few photos.</p><div className="chat-suggestions">{["I had poha and chai for breakfast", "Show today’s logged totals"].map(example => <button type="button" disabled={!!viewingAs} key={example} onClick={() => { setText(example); input.current?.focus(); }}>{example}</button>)}</div></div>}
        {messages.map(message => <ChatMessage activeActivityGoalDraft={state?.activityGoalDraft?.draftId} onReviewActivityGoals={setActivityGoalReview} activeActivityDraft={state?.activityDraft?.draftId} onReviewActivity={setActivityReview} key={message.id} activeProfileDraft={state?.profileDraft?.draftId} onSaveProfile={saveProfileProposal} message={message} activeGoalDraft={state?.goalDraft?.draftId} onReviewGoals={setGoalReview} activeDraft={state?.draft?.draftId} busy={waiting || !!viewingAs} onReview={setReview} />)}
        {state?.draft && !messages.some(message => message.id === state.draft!.draftId) && <ChatMessage message={{ id: state.draft.draftId, requestId: state.draft.draftId, sequence: 0, role: "assistant", content: "Your meal draft is still ready to review.", createdAt: "", payload: { state: "ready", draft: state.draft } }} activeDraft={state.draft.draftId} busy={waiting || !!viewingAs} onReview={setReview} />}
        {state?.goalDraft && !messages.some(message => message.id === state.goalDraft!.draftId) && <ChatMessage message={{ id: state.goalDraft.draftId, requestId: state.goalDraft.draftId, sequence: 0, role: "assistant", content: "Your goal proposal is still ready to review.", createdAt: "", payload: { state: "ready", goalDraft: state.goalDraft } }} activeGoalDraft={state.goalDraft.draftId} busy={waiting || !!viewingAs} onReview={setReview} onReviewGoals={setGoalReview} />}
        {state?.profileDraft && !messages.some(message => message.id === state.profileDraft!.draftId) && <ChatMessage activeProfileDraft={state.profileDraft.draftId} onSaveProfile={saveProfileProposal} message={{ id: state.profileDraft.draftId, requestId: state.profileDraft.draftId, sequence: 0, role: "assistant", content: "Your profile update is ready to review.", createdAt: "", payload: { state: "ready", profileDraft: state.profileDraft } }} busy={waiting || !!viewingAs} onReview={setReview} />}
        {state?.activityDraft && !messages.some(message => message.id === state.activityDraft!.draftId) && <ChatMessage activeActivityGoalDraft={state?.activityGoalDraft?.draftId} onReviewActivityGoals={setActivityGoalReview} activeActivityDraft={state.activityDraft.draftId} onReviewActivity={setActivityReview} message={{ id: state.activityDraft.draftId, requestId: state.activityDraft.draftId, sequence: 0, role: "assistant", content: "Your activity is ready to review.", createdAt: "", payload: { state: "ready", activityDraft: state.activityDraft } }} busy={waiting || !!viewingAs} onReview={setReview} />}
        {state?.activityGoalDraft && !messages.some(message => message.id === state.activityGoalDraft!.draftId) && <ChatMessage activeActivityGoalDraft={state.activityGoalDraft.draftId} onReviewActivityGoals={setActivityGoalReview} message={{ id: state.activityGoalDraft.draftId, requestId: state.activityGoalDraft.draftId, sequence: 0, role: "assistant", content: "Your activity goals are ready to review.", createdAt: "", payload: { state: "ready", activityGoalDraft: state.activityGoalDraft } }} busy={waiting || !!viewingAs} onReview={setReview} />}
        {visibleOptimistic && <ChatMessage message={optimistic} busy activeDraft={undefined} onReview={setReview} />}
        {waiting && <p className="chat-typing" role="status">Working on your reply… <span>You can switch tabs.</span></p>}
      </div>
      {error && <div className="chat-error" role="alert"><p>{error}</p>{!state && <button className="text-button" type="button" onClick={() => void load()} disabled={loading}>Retry</button>}</div>}
      {notice && <p className="chat-saved" role="status">{notice}</p>}
      {!viewingAs && <form className="chat-composer" aria-label="Message Kay" onSubmit={send}>
        {photos.length > 0 && <div className="chat-attachments">
          <div className="chat-photo-strip" aria-label="Attached photos">{photos.map((photo, index) => <div className="chat-photo-thumb" key={photo.id}><img src={photo.url} width="56" height="56" alt={`Food photo ${index + 1} ready to send`} /><button type="button" aria-label={`Remove photo ${index + 1}`} disabled={waiting || preparing} onClick={() => { selection.current++; const next = attachments.current.filter(item => item.id !== photo.id); replacePhotos(next); if (next.length < 2) setPhotoMode("auto"); retry.current = null; }}>×</button></div>)}</div>
          <div className="chat-photo-details"><span>{photos.length} of {MAX_CHAT_PHOTOS} photos</span>{photos.length > 1 && <label className="chat-photo-mode"><span className="sr-only">Photos show</span><select aria-label="Photos show" value={photoMode} disabled={waiting || preparing} onChange={event => { setPhotoMode(event.target.value as FoodChatPhotoMode); retry.current = null; }}><option value="auto">Let Kay work it out</option><option value="meal">Different dishes / one meal</option><option value="angles">Same food, different angles</option></select></label>}</div>
        </div>}
        <label className="sr-only" htmlFor="food-chat-message">Your message</label>
        <textarea id="food-chat-message" ref={input} rows={2} maxLength={1000} value={text} disabled={waiting || loading || !state || !state.quota.configured} placeholder="Message Kay…" onChange={event => { setText(event.target.value); retry.current = null; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canSend) event.currentTarget.form?.requestSubmit(); } }} />
        <div className="chat-composer-bottom"><div className="chat-attach-buttons"><label className="chat-icon-button" title="Take food photo"><ComposerIcon camera /><span className="sr-only">Take food photo</span><input className="sr-only" type="file" capture="environment" accept="image/*" aria-label="Take food photo" disabled={waiting || loading || preparing || !state?.quota.configured} onChange={choose} /></label><label className="chat-icon-button" title="Upload food photo"><ComposerIcon /><span className="sr-only">Upload food photo</span><input className="sr-only" type="file" accept="image/*" multiple aria-label="Upload food photo" disabled={waiting || loading || preparing || !state?.quota.configured} onChange={choose} /></label></div><p className="chat-allowance">{preparing ? "Preparing photo…" : state ? !state.quota.configured ? "AI logging isn’t connected yet." : limited ? creditLimited ? "Add credits to continue with Kay." : state.quota.remainingBudgetUsd < .01 ? "Kay’s shared spending limit is reached. Your credits are unchanged." : "Kay’s shared daily limit is reached. Your credits are unchanged." : "" : ""}</p><button className="chat-send" type="submit" aria-label="Send message" disabled={!canSend}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20V4m-7 7 7-7 7 7" /></svg></button></div>
      </form>}
    </div>
    {activityGoalReview && <ActivityGoalForm goals={activityGoalReview.goals} date={activityGoalReview.effectiveFrom} onClose={() => setActivityGoalReview(null)} saveGoals={async (goals, effectiveFrom) => {
      setBusy(true);
      try {
        const response = await fetch("/api/food/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId: activityGoalReview.draftId, activityGoals: { goals, effectiveFrom } }) });
        const next = await response.json();
        if (!response.ok) { void refresh().catch(() => {}); throw new Error(next.message || "Couldn’t save activity goals."); }
        apply(next);
      } finally { setBusy(false); }
    }} onSaved={() => { setActivityGoalReview(null); setNotice("Your activity goals are saved."); window.dispatchEvent(new Event("activity-goals-saved")); }} />}
    {activityReview && <ActivityForm draft={activityReview.activity} profile={{ weightKg: activityReview.activity.weightKg, age: activityReview.activity.ageSnapshot, heightCm: activityReview.activity.stepEstimate?.heightCm ?? null }} date={activityReview.activity.occurredAtLocal.slice(0, 10)} onClose={() => setActivityReview(null)} saveActivity={async activity => {
      setBusy(true);
      try {
        const response = await fetch("/api/food/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId: activityReview.draftId, activity }) });
        const next = await response.json();
        if (!response.ok) { void refresh().catch(() => {}); throw new Error(next.message || "Couldn’t save activity."); }
        apply(next);
      } finally { setBusy(false); }
    }} onSaved={() => { setActivityReview(null); setActivityGoalReview(null); setNotice("Saved to your activity journal."); window.dispatchEvent(new Event("activity-saved")); }} />}
    {goalReview && <GoalForm goals={goalReview.goals} initialEffectiveFrom={goalReview.effectiveFrom} onClose={() => setGoalReview(null)} saveGoals={async (goals, effectiveFrom) => {
      const response = await fetch("/api/food/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId: goalReview.draftId, goals: { ...goals, effectiveFrom, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } }) });
      const next = await response.json();
      if (!response.ok) { void refresh().catch(() => {}); throw new Error(next.message || "We couldn’t save your goals. Try again."); }
      apply(next);
    }} onSaved={() => { setGoalReview(null); setActivityReview(null); setActivityGoalReview(null); setNotice("Your food goals are saved."); window.dispatchEvent(new Event("food-goals-saved")); }} />}
    {review && <FoodForm entry={null} draft={review} date={review.eatenAtLocal.slice(0, 10)} draftLabel="Food estimate" saveLabel={review.targetEntryId ? "Save correction" : "Log meal"} onClose={() => setReview(null)} saveFood={async (food: FoodInput) => {
      const response = await fetch("/api/food/chat", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId: review.draftId, food }) });
      const next = await response.json();
      if (!response.ok) { void refresh().catch(() => {}); throw new Error(next.message || "We couldn’t save the meal. Try again."); }
      apply(next);
    }} onSaved={date => { setReview(null); setNotice("Saved to your food journal."); window.dispatchEvent(new CustomEvent("food-chat-saved", { detail: date })); }} />}
  </section>;
}

const ChatMessage = memo(function ChatMessage({ activeActivityGoalDraft, onReviewActivityGoals, activeActivityDraft, onReviewActivity, message, activeDraft, activeGoalDraft, activeProfileDraft, onSaveProfile, busy, onReview, onReviewGoals }: { activeActivityGoalDraft?: string; onReviewActivityGoals?: (draft: FoodChatActivityGoalDraft) => void; activeActivityDraft?: string; onReviewActivity?: (draft: FoodChatActivityDraft) => void; message: FoodChatMessage; activeProfileDraft?: string; onSaveProfile?: (id: string, changes: ProfileChange) => Promise<void>; activeDraft?: string; activeGoalDraft?: string; onReviewGoals?: (draft: FoodChatGoalDraft) => void; busy: boolean; onReview: (draft: FoodChatDraft) => void }) {
  const { payload } = message, draft = payload.draft, goalDraft = payload.goalDraft;
  const photoCount = payload.photoCount ?? (payload.hasPhoto ? 1 : 0);
  const mismatch = draft ? macroCalorieEstimate(draft) : null;
  return <article className={`chat-message chat-message-${message.role}`} aria-label={message.role === "user" ? "Your chat message" : "Kay reply"}>
    <p className="chat-speaker">{message.role === "user" ? "You" : "Kay"}</p>
    <div className="chat-message-content"><p className="chat-text">{message.content}</p>
      {photoCount > 0 && <span className="chat-photo-label"><ComposerIcon /> {photoCount === 1 ? "Photo attached" : `${photoCount} photos attached`}{photoCount > 1 && payload.photoMode === "angles" ? " · Same food, different angles" : photoCount > 1 && payload.photoMode === "meal" ? " · Different dishes" : ""}</span>}
      {payload.state === "failed" && <p className="chat-failed">Reply interrupted. Resend your message to try again.</p>}
      {payload.activityGoalDraft && <div className="chat-food-draft" aria-label="Activity goal proposal"><div className="chat-draft-heading"><h3>Daily activity goals</h3><span>{payload.state === "logged" ? "Saved" : "Proposal"}</span></div><dl className="chat-nutrition">{(["calories", "steps", "minutes"] as const).map(metric => <div key={metric}><dt>{metric === "calories" ? "Active calories" : metric === "steps" ? "Steps" : "Active minutes"}</dt><dd>{payload.activityGoalDraft!.goals[metric] === null ? "Not set" : number(payload.activityGoalDraft!.goals[metric]!)} <small>{payload.activityGoalDraft!.goals[metric] === null ? "" : metric === "calories" ? "kcal" : metric === "minutes" ? "min" : "steps"}</small></dd></div>)}</dl><p className="chat-draft-meta">Apply from {dates.format(new Date(payload.activityGoalDraft.effectiveFrom + "T12:00"))}</p><p className="chat-assumptions">{payload.activityGoalDraft.assumptions}</p>{payload.state === "logged" ? <p className="chat-saved">Activity goals saved. <Link href="/app?tab=activity" prefetch={false}>View activity</Link></p> : activeActivityGoalDraft === payload.activityGoalDraft.draftId ? <button className="primary-button" disabled={busy} onClick={() => onReviewActivityGoals?.(payload.activityGoalDraft!)}>Review activity goals</button> : <p className="chat-old-draft">Earlier proposal · See the latest reply.</p>}</div>}
      {payload.activityDraft && <div className="chat-food-draft" aria-label="Activity proposal"><div className="chat-draft-heading"><h3>{payload.activityDraft.activity.name}</h3><span>{payload.state === "logged" ? "Logged" : "Proposal"}</span></div><p>{payload.activityDraft.activity.calories === null ? "Calories not estimated" : `${number(payload.activityDraft.activity.calories)} kcal active`}{payload.activityDraft.activity.durationMinutes ? ` · ${number(payload.activityDraft.activity.durationMinutes)} min` : ""}{payload.activityDraft.activity.steps !== null ? ` · ${number(payload.activityDraft.activity.steps)} steps` : ""}</p><p className="chat-assumptions">{payload.activityDraft.activity.assumptions}</p>{payload.state === "logged" ? <p className="chat-saved">Saved to your activity journal. <Link href="/app?tab=activity" prefetch={false}>View activity</Link></p> : activeActivityDraft === payload.activityDraft.draftId ? <button className="primary-button" disabled={busy} onClick={() => onReviewActivity?.(payload.activityDraft!)}>Review activity</button> : <p className="chat-old-draft">Earlier proposal · See the latest reply.</p>}</div>}
      {payload.profileDraft && <ProfileProposal key={payload.profileDraft.draftId + payload.state} draft={payload.profileDraft} active={activeProfileDraft === payload.profileDraft.draftId} saved={payload.state === "logged"} busy={busy} onSave={onSaveProfile ?? (async () => {})} />}
      {goalDraft && <div className="chat-food-draft chat-goal-draft" aria-label={payload.state === "logged" ? "Saved goals" : "Goal proposal"}>
        <div className="chat-draft-heading"><h3>Daily food goals</h3><span>{payload.state === "logged" ? "Saved" : "Proposal"}</span></div>
        <dl className="chat-nutrition">{goalNutrients.map(key => <div key={key}><dt>{key === "calories" ? "Calories" : key[0].toUpperCase() + key.slice(1)}</dt><dd>{number(goalDraft.goals[key].min)}–{number(goalDraft.goals[key].max)} <small>{key === "calories" ? "kcal" : "g"}</small></dd></div>)}</dl>
        <p className="chat-draft-meta">Apply from {dates.format(new Date(goalDraft.effectiveFrom + "T12:00"))}</p>
        {goalDraft.assumptions && <p className="chat-assumptions">{goalDraft.assumptions}</p>}
        {payload.state === "logged" ? <p className="chat-saved"><span aria-hidden="true">✓</span> Goals saved. <Link href="/app?tab=food" prefetch={false}>View goals</Link></p> : activeGoalDraft === goalDraft.draftId ? <button className="primary-button" type="button" disabled={busy} onClick={() => onReviewGoals?.(goalDraft)}>Review goals</button> : <p className="chat-old-draft">Earlier proposal · See the latest reply.</p>}
      </div>}
      {draft && <div className="chat-food-draft" aria-label={payload.state === "logged" ? "Logged meal" : "Meal draft"}>
        <div className="chat-draft-heading"><h3>{draft.name || "Food entry"}</h3><span>{payload.state === "logged" ? payload.operation === "update" ? "Updated" : "Logged" : draft.targetEntryId ? "Correction" : "Estimate"}</span></div>
        <dl className="chat-nutrition">{[["Calories", number(draft.calories), "kcal"], ["Fat", number(draft.fat), "g"], ["Protein", number(draft.protein), "g"], ["Carbs", number(draft.carbs), "g"]].map(([label, value, unit]) => <div key={label}><dt>{label}</dt><dd>{value} <small>{unit}</small></dd></div>)}</dl>
        <p className="chat-draft-meta">{dates.format(new Date(draft.eatenAtLocal.slice(0, 10) + "T12:00"))}{draft.meal ? ` · ${draft.meal}` : ""} · {draft.category === "healthy" ? "Healthy" : "Unhealthy"}</p>
        {draft.assumptions && <p className="chat-assumptions">{draft.assumptions}</p>}
        {mismatch !== null && payload.state !== "logged" && <p className="macro-warning">The macros suggest about {number(mismatch)} kcal. Check the values in review.</p>}
        {payload.state === "logged" ? <p className="chat-saved"><span aria-hidden="true">✓</span> {payload.operation === "update" ? "Correction saved to your journal." : "Saved to your journal."} <Link href="/app?tab=food" prefetch={false}>View journal</Link></p> : activeDraft === draft.draftId ? <button className="primary-button" type="button" disabled={busy} onClick={() => onReview(draft)}>Review {draft.targetEntryId ? "correction" : "meal"}</button> : <p className="chat-old-draft">Earlier draft · See the latest reply.</p>}
      </div>}
      {payload.summary && <div className="chat-total" aria-label="Today’s logged nutrition"><strong>{number(payload.summary.calories)} kcal logged today</strong><span>{payload.summary.entries} entries · Fat {number(payload.summary.fat)} g · Protein {number(payload.summary.protein)} g · Carbs {number(payload.summary.carbs)} g</span></div>}
    </div>
  </article>;
});
