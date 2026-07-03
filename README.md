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
npx fair-clanker-stats --hours    # show hours per day instead of tokens
npx fair-clanker-stats --cost  # show $ spent per day (OpenCode, Pi, Oh My Pi)
npx fair-clanker-stats --share # copy chart to clipboard + open X
```

### Run from source

```bash
git clone https://github.com/8tomat8/fair-clanker-stats.git
cd fair-clanker-stats
npm install
node cli.js
```

## Supported tools

| Tool | Data source | `--cost` |
|------|------------|:---:|
| Claude Code | `~/.claude/projects/` | ✓* |
| Codex | `~/.codex/sessions/` | — |
| OpenCode | `~/.local/share/opencode/` (SQLite + JSON) | ✓ |
| Gemini CLI | `~/.gemini/tmp/` | — |
| Amp | `~/.local/share/amp/threads/` | — |
| Pi | `~/.pi/agent/sessions/` | ✓ |
| Oh My Pi | `~/.omp/agent/sessions/` | ✓ |
| Mistral Vibe | `~/.vibe/logs/session/` | — |

`--cost` shows API-billed spend as recorded by the tool itself; subscription-covered usage records $0.

\* Claude Code writes no cost to disk, so it is computed from token counts using a vendored Anthropic price table (TTL-aware cache-write rates, as `ccusage` does). Pi / Oh My Pi 1h-TTL cache writes are re-billed at the correct 2x-input rate to fix upstream underreporting.
