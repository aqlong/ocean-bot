// Custom not-found page. Two reasons this exists:
//
//   1. Without an explicit app/not-found.tsx, Next.js falls back to a
//      default that statically prerenders /_not-found / /404. In our
//      layout (which wraps every route, including 404) we mount the
//      AutoRefresh client component, which makes static prerender of
//      the fallback fragile in Next 15. Providing a server-rendered
//      not-found here avoids the prerender path entirely.
//
//   2. Gives Ocean a useful 404 instead of the generic Next page.

export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <div className="rounded border border-line bg-panel p-6 text-sm text-dim">
      <div className="text-ink">page not found</div>
      <div className="mt-1">
        Try <a href="/" className="text-accent hover:underline">overview</a>,{" "}
        <a href="/approvals" className="text-accent hover:underline">approvals</a>, or{" "}
        <a href="/settings" className="text-accent hover:underline">settings</a>.
      </div>
    </div>
  );
}
