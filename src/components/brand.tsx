import Link from "next/link";

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} prefetch={false} className="brand" aria-label="Daywell home">
      Daywell
    </Link>
  );
}
