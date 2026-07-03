# fair-clanker-stats

Fork of [clanker-stats](https://github.com/dnakov/clanker-stats) with SQLite support for OpenCode v1.2.0+.

See how many tokens you've burned across AI coding tools.

## Usage

```
npx fair-clanker-stats
```

Generates `chart.png` in the current directory and opens it.

### Options

```bash
npx fair-clanker-stats --hours               # show hours per day instead of tokens
npx fair-clanker-stats --cost                # show $ spent per day (estimates included)
npx fair-clanker-stats --cost --no-estimate  # only spend recorded by the tools themselves
npx fair-clanker-stats --share               # copy chart to clipboard + open X
```

### Run from source

```bash
git clone https://github.com/8tomat8/fair-clanker-stats.git
cd fair-clanker-stats
npm install
node cli.js
```

## Supported tools

| Tool | Data source | recorded cost | estimated |
|------|------------|:---:|:---:|
| Claude Code | `~/.claude/projects/` | ✓* | — |
| Codex | `~/.codex/sessions/` | — | ✓ |
| OpenCode | `~/.local/share/opencode/` (SQLite + JSON) | ✓ | ✓ |
| Gemini CLI | `~/.gemini/tmp/` | — | ✓ |
| Amp | `~/.local/share/amp/threads/` | — | ✓ |
| Pi | `~/.pi/agent/sessions/` | ✓ | — |
| Oh My Pi | `~/.omp/agent/sessions/` | ✓ | — |
| Mistral Vibe | `~/.vibe/logs/session/` | — | — |

`--cost` shows spend per day. Where a tool records real API billing, that number is used; subscription-covered usage (OAuth-billed Codex, OpenCode, Gemini CLI, Amp) records $0 on disk, so it is priced from its token splits at API list rates (Anthropic/OpenAI/Google tables vendored in `cli.js`, snapshot 2026-07-02) — "what it would have cost on API keys". `--no-estimate` disables the backfill and shows recorded spend only. OpenAI `-fast` tiers are assumed 2x base; Anthropic cache writes are priced at the 5m-TTL rate when the store keeps no TTL split.

\* Claude Code writes no cost to disk, so it is computed from token counts using a vendored Anthropic price table (TTL-aware cache-write rates, as `ccusage` does). Pi / Oh My Pi 1h-TTL cache writes are re-billed at the correct 2x-input rate to fix upstream underreporting.
