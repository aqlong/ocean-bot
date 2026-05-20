import { signIn } from "@/lib/auth";

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
