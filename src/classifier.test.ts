import { describe, it, expect } from "vitest";
import {
  applyRules,
  CRITICAL_RULE_IDS,
  isCriticalReason,
  splitDangerReasons,
  type ClassifierConfig,
} from "./classifier.js";
import type { DiffSummary, DangerReason } from "./adapters/types.js";

const code2wikiCfg: ClassifierConfig = {
  publisherPaths: ["src/core/publishers/"],
  auditPaths: ["src/core/audit.ts", "src/core/audit/"],
  schemaPaths: ["apps/dashboard/src/lib/db/schema.ts"],
  stripePaths: ["apps/dashboard/src/lib/stripe/"],
  onboardingDocPaths: ["apps/dashboard/SETUP.md", "README.md"],
  botSelfPaths: ["tools/ocean-bot/"],
  knownFetchHosts: [
    "api.anthropic.com",
    "api.github.com",
    "api.stripe.com",
    "api.notion.com",
  ],
};

function diff(files: string[], patch = "", added = 10, removed = 5): DiffSummary {
  return { files, added, removed, patch };
}

describe("classifier, rule 1 (publishers)", () => {
  it("flags src/core/publishers/ edits", () => {
    const r = applyRules(diff(["src/core/publishers/confluence.ts"]), code2wikiCfg);
    expect(r.map((x) => x.ruleId)).toContain(1);
  });

  it("does not flag adjacent non-publisher paths", () => {
    const r = applyRules(diff(["src/core/parsers/cfml.ts"]), code2wikiCfg);
    expect(r).toEqual([]);
  });
});

describe("classifier, rule 2 (audit)", () => {
  it("flags audit.ts edit", () => {
    const r = applyRules(diff(["src/core/audit.ts"]), code2wikiCfg);
    expect(r.map((x) => x.ruleId)).toContain(2);
  });

  it("flags audit subdirectory", () => {
    const r = applyRules(diff(["src/core/audit/chain.ts"]), code2wikiCfg);
    expect(r.map((x) => x.ruleId)).toContain(2);
  });
});

describe("classifier, rule 3 (destructive migration)", () => {
  it("flags schema edit + DROP COLUMN", () => {
    const r = applyRules(
      diff(
        ["apps/dashboard/src/lib/db/schema.ts"],
        "+ALTER TABLE foo DROP COLUMN bar",
      ),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).toContain(3);
  });

  it("does NOT flag schema edit with only additions", () => {
    const r = applyRules(
      diff(
        ["apps/dashboard/src/lib/db/schema.ts"],
        "+ALTER TABLE foo ADD COLUMN bar TEXT",
      ),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).not.toContain(3);
  });
});

describe("classifier, rule 4 (stripe charge path)", () => {
  it("flags stripe edit that touches a charge API", () => {
    const r = applyRules(
      diff(
        ["apps/dashboard/src/lib/stripe/charges.ts"],
        "+const c = await stripe.charges.create({ amount: 100 });",
      ),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).toContain(4);
  });

  it("does NOT flag stripe edit that's signature-verify only", () => {
    const r = applyRules(
      diff(
        ["apps/dashboard/src/lib/stripe/signature.ts"],
        "+const sig = computeHmac(rawBody, secret);",
      ),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).not.toContain(4);
  });
});

describe("classifier, rule 5 (onboarding docs with code blocks)", () => {
  it("flags SETUP.md with new code fence", () => {
    const r = applyRules(
      diff(
        ["apps/dashboard/SETUP.md"],
        "+```bash\n+code2wiki publish --config bad-example.json\n+```\n",
      ),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).toContain(5);
  });

  it("does NOT flag SETUP.md prose-only edits", () => {
    const r = applyRules(
      diff(["apps/dashboard/SETUP.md"], "+Fixed a typo in step 3.\n"),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).not.toContain(5);
  });
});

describe("classifier, rule 6 (diff size)", () => {
  it("flags > 500 lines", () => {
    const r = applyRules(diff(["src/a.ts"], "", 600, 0), code2wikiCfg);
    expect(r.map((x) => x.ruleId)).toContain(6);
  });

  it("flags > 10 files", () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const r = applyRules(diff(files), code2wikiCfg);
    expect(r.map((x) => x.ruleId)).toContain(6);
  });

  it("does NOT flag a 200-line, 3-file diff", () => {
    const r = applyRules(diff(["a.ts", "b.ts", "c.ts"], "", 150, 50), code2wikiCfg);
    expect(r.map((x) => x.ruleId)).not.toContain(6);
  });
});

describe("classifier, rule 7 (new external host)", () => {
  it("flags new host in fetch call", () => {
    const r = applyRules(
      diff(
        ["src/core/foo.ts"],
        '+const x = await fetch("https://evil.example.com/api");',
      ),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).toContain(7);
  });

  it("does NOT flag known hosts", () => {
    const r = applyRules(
      diff(
        ["src/core/foo.ts"],
        '+const x = await fetch("https://api.anthropic.com/v1/messages");',
      ),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).not.toContain(7);
  });

  it("ignores hosts only in removed lines", () => {
    const r = applyRules(
      diff(["src/core/foo.ts"], '-const x = await fetch("https://evil.example.com");'),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).not.toContain(7);
  });
});

describe("classifier, rule 8 (secrets / keys)", () => {
  it("flags .env edits", () => {
    expect(
      applyRules(diff([".env"]), code2wikiCfg).map((x) => x.ruleId),
    ).toContain(8);
  });

  it("flags .env.local edits", () => {
    expect(
      applyRules(diff([".env.local"]), code2wikiCfg).map((x) => x.ruleId),
    ).toContain(8);
  });

  it("flags *.pem", () => {
    expect(
      applyRules(diff(["secrets/github-app.pem"]), code2wikiCfg).map(
        (x) => x.ruleId,
      ),
    ).toContain(8);
  });

  it("flags paths matching secrets/", () => {
    expect(
      applyRules(diff(["secrets-store.json"]), code2wikiCfg).map((x) => x.ruleId),
    ).toContain(8);
  });

  // The four cases above are the ones the original regex handled. It
  // anchored `.env` and `secret` to the START of the filename, so the
  // realistic names below all walked past a CRITICAL rule. Each of these
  // was verified to evade before the fix; they are the regression set.
  describe("credential paths that used to evade the start-anchored regex", () => {
    const mustFlag = [
      // dotenv with a prefix rather than a prefix-less name
      "staging.env",
      "production.env",
      "config/.env.test",
      // "secret"/"credential" not at position zero
      "my-secrets.json",
      "aws-credentials.json",
      "credentials.json",
      "app/secret.yaml",
      // key material that is not a .pem
      "keys/app.key",
      "cert.p12",
      "cert.pfx",
      "service-account-key.json",
      "deploy/api-token.txt",
      // ssh private keys
      ".ssh/id_rsa",
      "id_ed25519",
      // auth config dotfiles
      ".npmrc",
      ".netrc",
      ".pgpass",
    ];

    for (const file of mustFlag) {
      it(`flags ${file}`, () => {
        expect(
          applyRules(diff([file]), code2wikiCfg).map((x) => x.ruleId),
        ).toContain(8);
      });
    }
  });

  // The widening has to stop short of ordinary source. A rule 8 hit is
  // CRITICAL: it blocks the push and demands operator approval. Flooding
  // on keyboard.ts would train the operator to wave rule 8 through, which
  // is a worse outcome than the gap this fix closes.
  describe("does not flag source files whose names merely contain key/token", () => {
    const mustNotFlag = [
      "src/keyboard.ts",
      "src/monkey.ts",
      "src/lib/keys.ts",
      "src/tokenizer.ts",
      "src/util/token.ts",
      "src/keymap.tsx",
      "src/core/tokens.ts",
      "docs/api-keys.md",
      "package.json",
      "README.md",
    ];

    for (const file of mustNotFlag) {
      it(`does NOT flag ${file}`, () => {
        expect(
          applyRules(diff([file]), code2wikiCfg).map((x) => x.ruleId),
        ).not.toContain(8);
      });
    }
  });

  it("names the offending file in the explanation", () => {
    // The operator sees only this string when deciding whether to approve.
    const reasons = applyRules(diff(["aws-credentials.json"]), code2wikiCfg);
    const rule8 = reasons.find((r) => r.ruleId === 8);
    expect(rule8?.explanation).toContain("aws-credentials.json");
  });
});

describe("classifier, rule 9 (CI workflows)", () => {
  it("flags .github/workflows/*.yml", () => {
    expect(
      applyRules(diff([".github/workflows/test.yml"]), code2wikiCfg).map(
        (x) => x.ruleId,
      ),
    ).toContain(9);
  });

  it("flags .yaml extension", () => {
    expect(
      applyRules(diff([".github/workflows/deploy.yaml"]), code2wikiCfg).map(
        (x) => x.ruleId,
      ),
    ).toContain(9);
  });

  it("does NOT flag dependabot.yml (not a workflow)", () => {
    expect(
      applyRules(diff([".github/dependabot.yml"]), code2wikiCfg).map(
        (x) => x.ruleId,
      ),
    ).not.toContain(9);
  });
});

describe("classifier, rule 10 (destructive git in patch)", () => {
  it("flags force-push in shell", () => {
    const r = applyRules(
      diff(["scripts/deploy.sh"], "+git push -f origin main"),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).toContain(10);
  });

  it("flags --force-with-lease", () => {
    const r = applyRules(
      diff(["scripts/deploy.sh"], "+git push --force-with-lease"),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).toContain(10);
  });

  it("flags git reset --hard", () => {
    const r = applyRules(
      diff(["scripts/reset.sh"], "+git reset --hard origin/main"),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).toContain(10);
  });

  it("flags branch -D", () => {
    const r = applyRules(
      diff(["scripts/cleanup.sh"], "+git branch -D stale-branch"),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).toContain(10);
  });

  // The rebase branch carries the only exemption in this rule, and it was
  // the only branch with no test. The exemption exists so the bot does not
  // flag its own recovery code: push.ts aborts a failed rebase to leave a
  // clean tree.
  describe("rebase, and the --abort exemption", () => {
    it("flags a plain rebase", () => {
      const r = applyRules(
        diff(["scripts/sync.sh"], "+git rebase origin/main"),
        code2wikiCfg,
      );
      expect(r.map((x) => x.ruleId)).toContain(10);
    });

    it("does NOT flag a bare rebase --abort", () => {
      const r = applyRules(
        diff(["src/push.ts"], "+  await git(dir, 'git rebase --abort');"),
        code2wikiCfg,
      );
      expect(r.map((x) => x.ruleId)).not.toContain(10);
    });

    // The exemption used to be written with a lookahead that scanned the
    // whole rest of the line, so mentioning --abort ANYWHERE downstream
    // suppressed the match. Both of these were verified to evade a rule
    // that is supposed to be unbypassable.
    it("flags a rebase chained before an abort on the same line", () => {
      const r = applyRules(
        diff(["scripts/sync.sh"], "+git rebase origin/main && git rebase --abort"),
        code2wikiCfg,
      );
      expect(r.map((x) => x.ruleId)).toContain(10);
    });

    it("flags a rebase whose trailing comment mentions --abort", () => {
      const r = applyRules(
        diff(["scripts/sync.sh"], "+git rebase origin/main # see git rebase --abort"),
        code2wikiCfg,
      );
      expect(r.map((x) => x.ruleId)).toContain(10);
    });

    it("flags a force-push even when the line also mentions --abort", () => {
      // Same class of bypass against a different clause: proves the fix is
      // scoped to the rebase lookahead and did not weaken the others.
      const r = applyRules(
        diff(["scripts/deploy.sh"], "+git push -f origin main # not git rebase --abort"),
        code2wikiCfg,
      );
      expect(r.map((x) => x.ruleId)).toContain(10);
    });
  });
});

describe("classifier, rule 11 (bot self-modification)", () => {
  it("flags any tools/ocean-bot/ edit", () => {
    const r = applyRules(diff(["tools/ocean-bot/src/queue.ts"]), code2wikiCfg);
    expect(r.map((x) => x.ruleId)).toContain(11);
  });

  it("flags nested bot edits", () => {
    const r = applyRules(
      diff(["tools/ocean-bot/dashboard/app/page.tsx"]),
      code2wikiCfg,
    );
    expect(r.map((x) => x.ruleId)).toContain(11);
  });
});

describe("classifier, composite", () => {
  it("reports multiple reasons for a multi-rule violation", () => {
    const r = applyRules(
      diff(
        [
          "src/core/publishers/notion.ts",
          ".env",
          ".github/workflows/test.yml",
        ],
        "+ALTER TABLE x DROP COLUMN y",
      ),
      code2wikiCfg,
    );
    const ids = r.map((x) => x.ruleId).sort((a, b) => a - b);
    expect(ids).toContain(1);
    expect(ids).toContain(8);
    expect(ids).toContain(9);
  });

  it("returns empty for a routine safe diff", () => {
    const r = applyRules(
      diff(
        ["src/core/util/slug.ts"],
        "+// trim trailing dashes from slug\n-// no-op\n",
        3,
        1,
      ),
      code2wikiCfg,
    );
    expect(r).toEqual([]);
  });
});

// ---- Severity helpers (2026-05-16). ----------------------------------
// The 11 classifier rules are partitioned into critical (block auto-push)
// and advisory (logged but auto-push proceeds). Pin the membership so a
// reshuffle of CRITICAL_RULE_IDS shows up as a failing test, not silent
// approval-routing drift.

describe("classifier severity split", () => {
  it("CRITICAL_RULE_IDS contains exactly 1, 2, 3, 4, 8, 10, 11", () => {
    expect([...CRITICAL_RULE_IDS].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 8, 10, 11,
    ]);
  });

  it("isCriticalReason is true for every critical rule id", () => {
    for (const ruleId of [1, 2, 3, 4, 8, 10, 11]) {
      expect(
        isCriticalReason({ ruleId, explanation: "x" }),
        `rule ${ruleId} should be critical`,
      ).toBe(true);
    }
  });

  it("isCriticalReason is false for every advisory rule id (5, 6, 7, 9)", () => {
    for (const ruleId of [5, 6, 7, 9]) {
      expect(
        isCriticalReason({ ruleId, explanation: "x" }),
        `rule ${ruleId} should be advisory`,
      ).toBe(false);
    }
  });

  it("splitDangerReasons partitions a mixed list, preserving order within each bucket", () => {
    const input: DangerReason[] = [
      { ruleId: 6, explanation: "large diff" }, // advisory
      { ruleId: 2, explanation: "audit edit" }, // critical
      { ruleId: 9, explanation: "ci workflow" }, // advisory
      { ruleId: 11, explanation: "bot self-mod" }, // critical
    ];
    const { critical, advisory } = splitDangerReasons(input);
    expect(critical.map((r) => r.ruleId)).toEqual([2, 11]);
    expect(advisory.map((r) => r.ruleId)).toEqual([6, 9]);
  });

  it("splitDangerReasons handles an empty list", () => {
    expect(splitDangerReasons([])).toEqual({ critical: [], advisory: [] });
  });
});
