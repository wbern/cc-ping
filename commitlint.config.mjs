// This config only runs when CLAUDECODE=1 (checked in .husky/commit-msg)
const noPromotionalText = (parsed) => {
  const message = parsed.raw;
  const promotionalPatterns = [
    /created with claude code/i,
    /generated with claude code/i,
    /🤖 generated with/i,
    /co-authored-by: claude/i,
  ];

  const hasPromotionalText = promotionalPatterns.some((pattern) =>
    pattern.test(message),
  );

  if (hasPromotionalText) {
    return [
      false,
      "Commit message contains promotional Claude Code text.\n" +
        "Remove references to being created/generated with Claude Code, including Co-Authored-By.\n\n" +
        'To disable co-authored-by credits, set "includeCoAuthoredBy": false in:\n' +
        "• Global: ~/.claude/settings.json\n" +
        "• Project: .claude/settings.local.json\n\n" +
        "Example:\n" +
        "{\n" +
        '  "includeCoAuthoredBy": false\n' +
        "}\n\n" +
        "More info: https://docs.anthropic.com/en/docs/claude-code/settings#available-settings",
    ];
  }

  return [true];
};

export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [
    {
      rules: {
        "no-promotional-text": noPromotionalText,
      },
    },
  ],
  rules: {
    "no-promotional-text": [2, "always"],
    "scope-case": [0],
    "scope-enum": [0],
    "subject-empty": [2, "never"],
    "subject-max-length": [2, "always", 100],
    "body-max-line-length": [1, "always", 100],
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "style",
        "refactor",
        "perf",
        "test",
        "chore",
        "build",
        "ci",
      ],
    ],
  },
};
