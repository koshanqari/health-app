export const profileSexOptions = ["female", "male", "intersex", "prefer_not_to_say"] as const;
export type ProfileSex = typeof profileSexOptions[number];
export const profileAvatars = [
  { id: "apple", label: "Apple" }, { id: "sprout", label: "Sprout" },
  { id: "cat", label: "Cat" }, { id: "bear", label: "Bear" },
  { id: "bunny", label: "Bunny" }, { id: "panda", label: "Panda" },
] as const;
export type ProfileAvatarId = typeof profileAvatars[number]["id"];
export type ProfileDetails = { name: string; dateOfBirth: string | null; sex: ProfileSex | null; avatarId: ProfileAvatarId | null };
export type UserProfile = ProfileDetails & { id: string; email: string; role: string };

export function parseProfile(value: unknown, existing?: ProfileDetails, now = new Date()): ProfileDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Check your profile details.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["name", "dateOfBirth", "sex", "avatarId", "timeZone"].includes(key))) throw new Error("Only your name, date of birth, sex and preset picture can be changed here.");
  const data: Record<string, unknown> = { ...existing, ...input };
  if (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(data.name)) throw new Error("Enter a name between 1 and 80 characters.");
  const timeZone = input.timeZone ?? "UTC";
  if (typeof timeZone !== "string" || timeZone.length > 64) throw new Error("Choose a valid time zone.");
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now); }
  catch { throw new Error("Choose a valid time zone."); }
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const dateOfBirth = data.dateOfBirth === "" || data.dateOfBirth == null ? null : data.dateOfBirth;
  if (dateOfBirth !== null) {
    if (typeof dateOfBirth !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) || dateOfBirth < "1900-01-01" || dateOfBirth > today) throw new Error("Enter a date of birth between 1900 and today.");
    const [year, month, day] = dateOfBirth.split("-").map(Number);
    if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== dateOfBirth) throw new Error("Enter a valid date of birth.");
  }
  const sex = data.sex === "" || data.sex == null ? null : data.sex;
  if (sex !== null && !profileSexOptions.includes(sex as ProfileSex)) throw new Error("Choose a valid sex option, or leave it unset.");
  const avatarId = data.avatarId === "" || data.avatarId == null ? null : data.avatarId;
  if (avatarId !== null && !profileAvatars.some(avatar => avatar.id === avatarId)) throw new Error("Choose one of the preset profile pictures.");
  return { name: data.name.trim(), dateOfBirth, sex: sex as ProfileSex | null, avatarId: avatarId as ProfileAvatarId | null };
}
