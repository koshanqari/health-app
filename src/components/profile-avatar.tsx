import type { ProfileAvatarId } from "@/lib/profile";

function Smile({ y = 0 }: { y?: number }) {
  return <g transform={`translate(0 ${y})`} stroke="#214E2C" strokeWidth="2.4" strokeLinecap="round" fill="none"><path d="M22 32q3-4 6 0m8 0q3-4 6 0M27 39q5 6 10 0" /></g>;
}

export function ProfileAvatar({ avatarId, name }: { avatarId: ProfileAvatarId | null; name: string }) {
  if (!avatarId) return <span aria-hidden="true" data-avatar-id="initials">{name.trim().slice(0, 1).toUpperCase()}</span>;
  return <svg viewBox="0 0 64 64" width="64" height="64" fill="none" aria-hidden="true" focusable="false" data-avatar-id={avatarId}>
    {avatarId === "apple" && <>
      <path d="M10 34c-1-14 9-23 23-22 15-1 24 10 22 25-2 15-11 24-24 24C17 60 10 48 10 34Z" fill="#81C995" />
      <path d="M32 13C29 6 34 2 40 1c1 7-2 11-8 12Z" fill="#34A853" /><Smile />
    </>}
    {avatarId === "sprout" && <>
      <path d="M32 32V15" stroke="#34834B" strokeWidth="3" strokeLinecap="round" />
      <path d="M32 23C18 24 11 17 12 8c12 0 20 6 20 15Z" fill="#81C995" /><path d="M32 18C32 7 39 3 51 4c0 10-7 16-19 14Z" fill="#34A853" />
      <path d="M12 28h40l-4 25c-1 5-6 8-16 8s-15-3-16-8Z" fill="#A8DAB5" /><path d="M11 28h42v7H11Z" fill="#81C995" /><Smile y={10} />
    </>}
    {avatarId === "cat" && <>
      <path d="M11 29 10 7l17 12h10L54 7l-1 22c8 20-3 31-21 31S3 49 11 29Z" fill="#E4C49E" />
      <path d="m15 17 8 5-8 4Zm34 0-8 5 8 4Z" fill="#D6A88F" /><Smile y={2} />
      <path d="m13 39 8 1m-8 5 8-1m30-5-8 1m8 5-8-1" stroke="#8C6848" strokeWidth="1.5" strokeLinecap="round" />
    </>}
    {avatarId === "bear" && <>
      <circle cx="16" cy="17" r="10" fill="#C89A67" /><circle cx="48" cy="17" r="10" fill="#C89A67" />
      <circle cx="16" cy="17" r="5" fill="#E4C49E" /><circle cx="48" cy="17" r="5" fill="#E4C49E" />
      <ellipse cx="32" cy="36" rx="24" ry="25" fill="#C89A67" /><ellipse cx="32" cy="42" rx="12" ry="10" fill="#F0DFC5" />
      <Smile /><ellipse cx="32" cy="36" rx="3" ry="2" fill="#6C513A" />
    </>}
    {avatarId === "bunny" && <>
      <ellipse cx="21" cy="19" rx="8" ry="18" transform="rotate(-9 21 19)" fill="#E7ECDD" /><ellipse cx="43" cy="19" rx="8" ry="18" transform="rotate(9 43 19)" fill="#E7ECDD" />
      <ellipse cx="21" cy="17" rx="3" ry="10" transform="rotate(-9 21 17)" fill="#E8C7BB" /><ellipse cx="43" cy="17" rx="3" ry="10" transform="rotate(9 43 17)" fill="#E8C7BB" />
      <ellipse cx="32" cy="40" rx="23" ry="21" fill="#E7ECDD" /><Smile y={5} />
      <circle cx="18" cy="44" r="3" fill="#E8C7BB" /><circle cx="46" cy="44" r="3" fill="#E8C7BB" />
    </>}
    {avatarId === "panda" && <>
      <circle cx="15" cy="17" r="10" fill="#425347" /><circle cx="49" cy="17" r="10" fill="#425347" />
      <ellipse cx="32" cy="36" rx="25" ry="25" fill="#E7ECDD" />
      <ellipse cx="22" cy="33" rx="7" ry="9" transform="rotate(22 22 33)" fill="#425347" /><ellipse cx="42" cy="33" rx="7" ry="9" transform="rotate(-22 42 33)" fill="#425347" />
      <circle cx="23" cy="31" r="2.1" fill="#FFFEFA" /><circle cx="41" cy="31" r="2.1" fill="#FFFEFA" />
      <ellipse cx="32" cy="39" rx="3" ry="2" fill="#425347" /><path d="M27 45q5 5 10 0" stroke="#425347" strokeWidth="2.4" strokeLinecap="round" />
    </>}
  </svg>;
}
