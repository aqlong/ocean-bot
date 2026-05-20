import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0f14",
        panel: "#121821",
        ink: "#e6edf3",
        dim: "#7d8590",
        line: "#1f2630",
        accent: "#58a6ff",
        good: "#3fb950",
        warn: "#d29922",
        bad: "#f85149",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
} satisfies Config;
