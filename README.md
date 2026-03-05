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
npx fair-clanker-stats --share    # copy chart to clipboard + open X
```

### Run from source

```bash
git clone https://github.com/8tomat8/fair-clanker-stats.git
cd fair-clanker-stats
npm install
node cli.js
```

## Supported tools

| Tool | Data source |
|------|------------|
| Claude Code | `~/.claude/projects/` |
| Codex | `~/.codex/sessions/` |
| OpenCode | `~/.local/share/opencode/` (SQLite + JSON fallback) |
| Gemini CLI | `~/.gemini/tmp/` |
| Amp | `~/.local/share/amp/threads/` |
| Pi | `~/.pi/agent/sessions/` |
| Mistral Vibe | `~/.vibe/logs/session/` |
