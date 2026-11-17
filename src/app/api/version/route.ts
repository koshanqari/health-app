export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ release: process.env.NEXT_PUBLIC_APP_RELEASE || "local" }, {
    headers: { "Cache-Control": "no-store, max-age=0", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store" },
  });
}
