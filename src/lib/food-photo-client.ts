export async function prepareFoodPhoto(file: File) {
  if (file.size > 20 * 1024 * 1024) throw new Error("Choose a photo smaller than 20 MB.");
  if (file.type && !["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/avif"].includes(file.type)) throw new Error("Choose a JPEG, PNG, WebP, or phone camera photo.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new Error("This photo couldn’t be opened. Try a JPEG photo or take a new picture."); }
  try {
    const ratio = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser couldn’t prepare the photo.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("This photo couldn’t be prepared.")), "image/jpeg", .78));
    if (blob.size > 1024 * 1024) throw new Error("This photo is too large after resizing. Try a simpler or smaller photo.");
    return new File([blob], "food.jpg", { type: "image/jpeg" });
  } finally { bitmap.close(); }
}


// randomUUID is unavailable on ordinary HTTP LAN origins; getRandomValues still works.
export function foodRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
