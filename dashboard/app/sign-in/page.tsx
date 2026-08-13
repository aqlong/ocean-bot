import { signIn } from "@/lib/auth";

// Load-bearing: the root layout renders <BotStatusBadge />, which queries
// ocean_bot_state. Without force-dynamic this page is the one route Next
// prerenders at build time, so `next build` opens a Postgres connection and
// fails on any machine without a reachable DB (fresh clone, CI, Docker
// build stage). Every sibling page already declares it; sign-in was missed
// because it has no data of its own. See dashboard/app/no-static.test.ts.
export const dynamic = "force-dynamic";

export default function SignIn() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4">
      <h1 className="text-xl font-bold">🌊 ocean-bot</h1>
      <p className="text-dim text-sm">single-user dashboard</p>
      <form
        action={async () => {
          "use server";
          await signIn("github");
        }}
      >
        <button
          type="submit"
          className="rounded border border-line bg-panel px-4 py-2 text-ink hover:border-accent"
        >
          sign in with GitHub
        </button>
      </form>
    </div>
  );
}
