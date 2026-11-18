export const profileSexOptions = ["female", "male", "intersex", "prefer_not_to_say"] as const;
export type ProfileSex = typeof profileSexOptions[number];
export const profileAvatars = [
  { id: "apple", label: "Apple" }, { id: "sprout", label: "Sprout" },
  { id: "cat", label: "Cat" }, { id: "bear", label: "Bear" },
  { id: "bunny", label: "Bunny" }, { id: "panda", label: "Panda" },
] as const;
export type ProfileAvatarId = typeof profileAvatars[number]["id"];
export type ProfileDetails = { name: string; age: number | null; weightKg: number | null; sex: ProfileSex | null; avatarId: ProfileAvatarId | null; heightCm: number | null };
export type UserProfile = ProfileDetails & { id: string; email: string; role: string; ageUpdatedAt: string | null; weightUpdatedAt: string | null };

export function parseProfile(value: unknown, existing?: ProfileDetails): ProfileDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Check your profile details.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["name", "age", "weightKg", "sex", "avatarId", "heightCm", "timeZone"].includes(key))) throw new Error("Only your name, age, sex, height, weight and preset picture can be changed here.");
  const data: Record<string, unknown> = { ...existing, ...input };
  if (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(data.name)) throw new Error("Enter a name between 1 and 80 characters.");
  if (input.timeZone !== undefined) {
    if (typeof input.timeZone !== "string" || input.timeZone.length > 64) throw new Error("Choose a valid time zone.");
    try { new Intl.DateTimeFormat("en", { timeZone: input.timeZone }); } catch { throw new Error("Choose a valid time zone."); }
  }
  const age = data.age === "" || data.age == null ? null : data.age;
  if (age !== null && (typeof age !== "number" || !Number.isInteger(age) || age < 0 || age > 130)) throw new Error("Enter an age between 0 and 130 whole years.");
  const weightKg = data.weightKg === "" || data.weightKg == null ? null : data.weightKg;
  if (weightKg !== null && (typeof weightKg !== "number" || !Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 500 || Math.abs(weightKg * 10 - Math.round(weightKg * 10)) > .000001)) throw new Error("Enter a weight above 0 and up to 500 kg, with at most one decimal place.");
  const sex = data.sex === "" || data.sex == null ? null : data.sex;
  if (sex !== null && !profileSexOptions.includes(sex as ProfileSex)) throw new Error("Choose a valid sex option, or leave it unset.");
  const avatarId = data.avatarId === "" || data.avatarId == null ? null : data.avatarId;
  if (avatarId !== null && !profileAvatars.some(avatar => avatar.id === avatarId)) throw new Error("Choose one of the preset profile pictures.");
  const heightCm = data.heightCm === "" || data.heightCm == null ? null : data.heightCm;
  if (heightCm !== null && (typeof heightCm !== "number" || !Number.isFinite(heightCm) || heightCm <= 0 || heightCm > 300 || Math.abs(heightCm * 10 - Math.round(heightCm * 10)) > .000001)) throw new Error("Enter a height above 0 and up to 300 cm, with at most one decimal place.");
  return { name: data.name.trim(), age, weightKg, sex: sex as ProfileSex | null, avatarId: avatarId as ProfileAvatarId | null, heightCm };
}

export const profileChangeFields = ["age", "sex", "heightCm", "weightKg"] as const;
export type ProfileChangeField = typeof profileChangeFields[number];
export type ProfileChange = Partial<Pick<ProfileDetails, ProfileChangeField>>;
export function parseProfileChange(value: unknown): ProfileChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Check the profile update.");
  const keys = Object.keys(value);
  if (!keys.length || keys.some(key => !profileChangeFields.includes(key as ProfileChangeField))) throw new Error("A profile proposal can update only age, sex, height and weight.");
  const parsed = parseProfile({ name: "Profile", ...value });
  return Object.fromEntries(keys.map(key => [key, parsed[key as ProfileChangeField]]));
}
