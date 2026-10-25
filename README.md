# Hermit Stats

Word, speech and interaction statistics for every Hermitcraft episode, published as a static site at
**https://hermit-stats.com** (www. redirects there).

Pick a season and any Hermits (or all of them) and see:

| Tab | What's there |
|---|---|
| **Overview** | What's new since your last visit (episodes, Hermits talking about each other for the first time, words of the week); a downloadable share card per selected Hermit; episodes, hours, words spoken, views, likes; uploads per week; running word count; footage per Hermit; episode-length spread; upload weekdays |
| **Words** | Word cloud; top words, two- and three-word phrases; each Hermit's *signature words* (log-odds against everyone else) and *catchphrases* (distinctive phrases ranked by how many of their episodes they're in); themed vocabularies (mobs, materials, redstone, Hermitcraft life, exclamations, fillers) in total and per 10k words |
| **Interactions** | Network of who names whom on camera; mention matrix (per hour or total); who a Hermit talks about / who talks about them; top contacts over time; Hermits named in episode titles |
| **Speech** | Pace, vocabulary richness (MATTR), filler words, exclamations, laughter; radar profile when comparing; usual openings and sign-offs |
| **Videos** | Views by date and by length, length by episode number, likes per 1k views, sortable table of every episode |
| **Search** | Any words or phrases: count per Hermit, trend over the season, and every moment with a link to that timestamp; with nothing searched, a catchphrase leaderboard |

Click an episode anywhere (Videos table or charts, search results, What's new) for its own page: its numbers
against that Hermit's usual, who's named when (each dot links to that moment), pace through the episode, the
words that stand out from their other episodes, and the transcript. **Status** (footer link) shows when the site
was built, the last sync run, every video still waiting for a transcript and why, and episodes missing from
their creator's own season playlist (found by title instead).

Selecting 1–3 Hermits compares them side by side (each keeps one colour everywhere). Every chart has a
**Table** view. The URL keeps the selection, so links can be shared.

## How it works

```
CT 112 on Proxmox pve1 (home IP)                      Luma001 (Hetzner)
  yt-dlp: playlists, metadata, captions                Caddy file_server
  faster-whisper when a video has no captions   ──►    /root/caddy/static/hermit-stats
  analysis → site/data/*.json   (rsync)                 (no container, no app process)
```

All the work happens at home, in LXC `hermit-stats` (CT 112, 192.168.1.227, user `hermit`, repo
`~/hermit-stats`); its database is the only live copy. The server only serves files. YouTube also bot-checks datacenter IPs, so
fetching from the server wouldn't work anyway.

- `hermits.toml` — the roster (channel, short name, aliases incl. caption mishearings, exclusions like
  "ender pearl"), the seasons (playlist-title / video-title patterns, skip pattern, start date) and the deploy
  target.
- Each Hermit's season videos come from their channel's playlist whose title matches; channels without one
  fall back to uploads whose title matches. Livestream / shorts playlists are skipped.
- `site/data/`: `videos.json` (one row per episode), `words/` and `transcripts/` and `episodes/` (one file per
  Hermit, loaded when needed), `meta.json`, `status.json`.
- A **mention** is another Hermit's name (or alias) spoken in an episode; the speaker's own name isn't counted.
- **Who's talking.** Captions don't say, so by default every word in an episode counts as the channel owner's.
  `hermit-stats voices "Season 11"` fixes that from the audio (`speakers.py`): Silero VAD finds the speech, each
  1.5 s window gets a voiceprint (WeSpeaker ResNet34, an open ONNX model, no account needed), and each Hermit's
  voiceprint is the densest part of their windows across their own episodes, where they're nearly always the
  main voice. Every window is matched to the nearest Hermit (or left unknown), and the caption words, re-fetched
  with per-word times, are split where the voice changes. The `speech` table holds the result; the build then
  credits words, phrases, mentions and search hits to whoever said them, and episodes without a row work as
  before. It's CPU work (~80x realtime on 32 cores, ~40 s an episode with the download), so it runs on the
  desktop, not CT 112; windows and word times stay in `cache/voices/`, so `voices --relabel` redoes who's who
  without YouTube.
  Auto-captions mishear names, so counts are close, not exact.

## Usage

```sh
uv sync
uv run hermit-stats sync              # find new episodes, fetch captions (Whisper fallback), refresh recent views
uv run hermit-stats build             # analyse → site/
uv run hermit-stats serve --open      # preview at http://127.0.0.1:8650/
uv run hermit-stats push              # rsync site/ to the server
uv run hermit-stats update            # all three: sync, build, push
uv run hermit-stats status            # videos / transcripts per Hermit
uv run hermit-stats sync Grian Mumbo  # just some Hermits
uv run hermit-stats import-ytlex ../ytlex/ytlex.db   # one-off: reuse ytlex transcripts
uv run hermit-stats voices "Season 11"   # who's talking, from the audio (hours; resumable)
uv run --extra dev pytest             # tests
```

If YouTube says *"Sign in to confirm you're not a bot"*, `sync` stops early (everything fetched so far is
kept). Wait an hour, or add `--cookies-from-browser chromium` (or `--cookies cookies.txt`, a Netscape-format export,
on a machine without a browser). `--workers` (default 2) and `--pause MIN MAX`
(default 1–3 s) control how hard it pushes.

Add a season by uncommenting / adding a `[[collection]]` in `hermits.toml`; the season picker appears
automatically.

### Nightly update

```sh
deploy/install-timer.sh
```

Installs a systemd user timer for wherever the repo is checked out, and turns on lingering so it runs
without a login. Runs `hermit-stats update` at ~06:30 (after the router's overnight block for unlisted
devices ends); output in `logs/update.log`. Before each run it installs `uv.lock` and upgrades yt-dlp, since
YouTube breaks old versions. A failed run retries every 30 min (3 times at most); a run is killed after 8 h.
Extra flags for that machine go in `deploy/hermit-stats.env` (not committed), e.g.
`HERMIT_STATS_ARGS=--whisper-limit 3 --cookies cookies.txt`. `--whisper-limit` keeps a run bounded on a
CPU-only box: caption-less videos beyond the limit wait for the next night, newest first.

Each run re-lists every Hermit's season playlists and also title-matches their 30 newest uploads, so an
episode that hasn't been added to the playlist yet is still picked up. Videos that failed (premiere not
started, members-only for now) are retried on the next run. Only one machine should run the timer: the
database is the source of truth.

`voices` runs on the desktop against a copy of CT 112's database, so its `speech` rows are copied back by hand
(only that table; everything else stays CT 112's):

```sh
sqlite3 hermit-stats.db ".mode insert speech" "SELECT * FROM speech" | sed 's/^INSERT INTO/INSERT OR REPLACE INTO/' > speech.sql
# on CT 112:  sqlite3 hermit-stats.db < speech.sql
```

`deploy/install-timer.sh voices` does that every day at 10:00 (after CT 112's own update), or when the desktop
next wakes up: `deploy/voices-nightly.sh` takes a fresh copy of CT 112's database, runs `voices` on the seasons
in `deploy/voices.env` (`PROXMOX=root@…`, `CT=112`, `SEASONS="Season 9|Season 10|Season 11"`; not committed), replaces
CT 112's `speech` rows and rebuilds the site there. Output in `logs/voices.log`. It holds `logs/voices.lock`, so
a hand-run `voices` should too: `flock logs/voices.lock uv run hermit-stats voices …`.

Episodes uploaded after a `voices` run count every word as the owner's until the next one.

## Server

`/root/caddy/Caddyfile` on Luma001 has the blocks in `deploy/Caddyfile.snippet`; Caddy already mounts
`/root/caddy/static` read-only at `/srv/static`. DNS: `hermit-stats.com` (123-Reg, GoDaddy nameservers) has an
A record for `@` → `178.104.29.66` and `www` as a CNAME to it. Caddy fetches certificates itself.

## Tests

```sh
uv run --extra dev pytest -q
```
