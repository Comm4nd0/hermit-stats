"""hermit-stats: sync Hermitcraft playlists, build the stats site, publish it."""

import argparse
import functools
import json
import random
import http.server
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from rich.console import Console
from rich.progress import BarColumn, MofNCompleteColumn, Progress, TextColumn, TimeElapsedColumn
from rich.table import Table

from . import build as builder
from . import config as configmod
from . import db, youtube
from .transcribe import Whisper, from_captions

console = Console()


def _cfg(args):
    return configmod.load(args.config)


# ---------------------------------------------------------------- sync

# Hermits often add an episode to their season playlist days late, or forget; their newest uploads are also
# matched by title so those episodes aren't missed. Once a season has ended, all their uploads are matched,
# once (kv "swept:<channel>:<season>"), for the episodes that never made it into the playlist.
RECENT_UPLOADS = 30


def _discover(conn, cfg, hermit, cookies) -> int:
    """Find the hermit's collection videos (playlists first, title match as fallback). Returns how many.
    Commits after each batch of writes, never across a YouTube request, so a build can run meanwhile."""
    info = youtube.channel_playlists(hermit.url, cookies)
    db.upsert_channel(conn, info["id"], hermit.slug, info["name"], hermit.url, info["avatar_url"])
    conn.commit()
    found = 0
    uploads = recent = None
    today = time.strftime("%Y%m%d")
    # Stream recordings aren't episodes, even filed in a season playlist.
    live = youtube.live_ids(hermit.url, cookies)
    for coll in cfg.collections:
        if not coll.includes(hermit):
            continue
        picked = [(pid, title) for pid, title in info["playlists"] if coll.playlist.search(title) and coll.wants(title)]
        manual = hermit.playlists.get(coll.name)
        if manual:
            pid = youtube_playlist_id(manual)
            if pid not in {p for p, _ in picked}:
                picked.append((pid, coll.name))
        ids = set()
        for pid, title in picked:
            listed = youtube.list_playlist(pid, cookies)
            db.upsert_playlist(conn, pid, info["id"], title, coll.name)
            for v in listed:
                if coll.side(v["title"]) or v["id"] in live or coll.stream(v["title"], v.get("duration")):
                    continue                  # a Hermit's UHC, modded episodes or streams filed in their season playlist
                db.upsert_video(conn, info["id"], v)
                db.add_to_collection(conn, coll.name, v["id"], f"playlist:{pid}")
                ids.add(v["id"])
            conn.commit()
        in_playlists = len(ids)
        if coll.video_title:
            swept = f"swept:{info['id']}:{coll.name}"
            if picked and not (coll.ends and coll.ends < today and not db.get_kv(conn, swept)):
                if recent is None:
                    recent = youtube.list_uploads(hermit.url, latest=RECENT_UPLOADS, cookies=cookies)
                candidates = recent
            else:
                if uploads is None:
                    uploads = youtube.list_uploads(hermit.url, cookies=cookies)
                candidates = uploads
            for v in candidates:
                if v["id"] not in ids and v["id"] not in live and coll.video_title.search(v["title"] or "") \
                        and coll.wants(v["title"], v["upload_date"]) and not coll.stream(v["title"], v.get("duration")):
                    db.upsert_video(conn, info["id"], v)
                    db.add_to_collection(conn, coll.name, v["id"], "title")
                    ids.add(v["id"])
            if picked and candidates is uploads:
                db.set_kv(conn, swept, today)
            conn.commit()
        # A stream, compilation or side series matched before `skip` / `side_series` / `streams` knew better.
        for vid, title, duration, via in conn.execute(
                """SELECT v.id, v.title, v.duration, cv.via FROM collection_videos cv JOIN videos v ON v.id = cv.video_id
                   WHERE cv.collection = ? AND v.channel = ?""", (coll.name, info["id"])).fetchall():
            if coll.side(title) or vid in live or coll.stream(title, duration) or via == "title" and not coll.wants(title):
                db.remove_from_collection(conn, coll.name, vid)
                ids.discard(vid)
        conn.commit()
        how = (f"{len(picked)} playlist{'s' * (len(picked) != 1)}" if picked
               else "title match" if coll.video_title else "nothing to match")
        extra = f" (+{len(ids) - in_playlists} not in a playlist)" if len(ids) > in_playlists and picked else ""
        console.print(f"  {hermit.name:<20} {coll.name}: [bold]{len(ids)}[/] videos via {how}{extra}")
        found += len(ids)
    return found


def youtube_playlist_id(s: str) -> str:
    m = re.search(r"[?&]list=([\w-]+)", s)
    return m.group(1) if m else s.strip()


def _cookies(args) -> youtube.Cookies | None:
    if args.cookies_from_browser or args.cookies:
        return youtube.Cookies(browser=args.cookies_from_browser, file=args.cookies)
    return None


def _fetch(vid: str, need_transcript: bool, colls: list, args):
    """Network part of processing one video, run in worker threads. A video turning out to be from outside every
    season it was matched to (its date is only known now) needs no transcript."""
    time.sleep(random.uniform(*args.pause))     # YouTube bot-checks bursts of requests from one IP
    meta, info = youtube.fetch_details(vid, _cookies(args))
    need_transcript = need_transcript and _in_season(colls, meta["upload_date"])
    captions = None
    if need_transcript and args.whisper != "always":
        captions = from_captions(info, args.lang, allow_auto=True)
    return meta, info, captions, need_transcript


def _in_season(colls: list, upload_date: str | None) -> bool:
    return not colls or any(c.wants("", upload_date) for c in colls)


def cmd_sync(args) -> int:
    cfg = _cfg(args)
    conn = db.connect(args.db)
    started = int(time.time())
    hermits = [cfg.hermit(h) for h in args.hermit] if args.hermit else cfg.hermits
    if args.cookies and not args.cookies.is_file():
        console.print(f"[red]No cookies file at {args.cookies}[/]")
        return 1

    if not args.no_discover:
        console.print(f"[bold]Finding videos[/] for {len(hermits)} Hermits")
        for h in hermits:
            try:
                _discover(conn, cfg, h, _cookies(args))
            except Exception as e:     # a renamed / missing channel shouldn't stop the rest
                console.print(f"  [red]{h.name}: {str(e).splitlines()[0][:160]}[/]")

    slugs = {h.slug for h in hermits}
    todo = [r for r in db.pending(conn) if conn.execute(
        "SELECT hermit FROM channels WHERE id=?", (r["channel"],)).fetchone()[0] in slugs]
    # Recent uploads' views and likes still move: refresh them once a week for two months.
    stale_before = time.time() - 7 * 86400
    recent = time.strftime("%Y%m%d", time.gmtime(time.time() - 60 * 86400))
    refresh = [] if args.no_refresh else conn.execute(
        """SELECT DISTINCT v.* FROM videos v JOIN collection_videos cv ON cv.video_id = v.id
           JOIN transcripts t ON t.video_id = v.id
           WHERE (v.upload_date >= ? AND v.details_at < ?) OR ? = 1""",
        (recent, stale_before, 1 if args.refresh_all else 0)).fetchall()
    refresh = [r for r in refresh if r["id"] not in {t["id"] for t in todo}]
    if args.whisper_limit == 0:     # a captions-only run: don't ask YouTube again about videos known to need Whisper
        todo = [r for r in todo if r["error"] != "whisper-wait"]
    # Untranscribed first; imported videos that only lack likes / release time come after. Then season by
    # season in hermits.toml order, so a long backfill finishes (and can publish) whole seasons one at a time.
    rank = {c.name: i for i, c in enumerate(cfg.collections)}
    season = {}
    for vid, coll in conn.execute("SELECT video_id, collection FROM collection_videos"):
        season[vid] = min(season.get(vid, len(rank)), rank.get(coll, len(rank)))
    todo = [r for r in todo if season.get(r["id"], len(rank)) < len(rank)]    # skip seasons no longer configured
    colls_of = {}
    for vid, coll in conn.execute("SELECT video_id, collection FROM collection_videos"):
        if coll in rank:
            colls_of.setdefault(vid, []).append(cfg.collections[rank[coll]])
    # A loose title pattern (Season 1's) also matches later seasons' episodes; their dates rule them out.
    todo = [r for r in todo if db.has_transcript(conn, r["id"]) or _in_season(colls_of.get(r["id"]), r["upload_date"])]
    todo.sort(key=lambda r: (db.has_transcript(conn, r["id"]), season.get(r["id"], len(rank))))
    if args.limit:
        todo = todo[:args.limit]
    work = [(r, True) for r in todo] + [(r, False) for r in refresh]
    console.print(f"\n[bold]{len(todo)}[/] videos to transcribe, {len(refresh)} to refresh")
    run = {"started": started, "todo": len(todo), "refresh": len(refresh), "processed": 0, "transcribed": 0,
           "whispered": 0, "failed": 0, "bot_check": False}
    if not work:
        _record_sync(conn, run)
        return 0

    whisper = Whisper(args.model, args.device, args.cache) if args.whisper != "never" else None
    known = {r["id"]: r["hermit"] for r in conn.execute("SELECT id, hermit FROM channels")}
    done = failed = whispered = transcribed = bot = 0
    progress = Progress(TextColumn("{task.description}"), BarColumn(), MofNCompleteColumn(),
                        TimeElapsedColumn(), console=console)
    with progress, ThreadPoolExecutor(args.workers) as pool:
        task = progress.add_task("Fetching", total=len(work))
        futures = {pool.submit(_fetch, r["id"], need and not db.has_transcript(conn, r["id"]), colls_of.get(r["id"]), args): (r, need)
                   for r, need in work}
        for fut in as_completed(futures):
            r, need = futures[fut]
            progress.update(task, description=f"[dim]{(r['title'] or r['id'])[:50]}")
            try:
                meta, info, captions, wanted = fut.result()
                owner = info.get("channel_id") or r["channel"]
                if (info.get("uploader_id") or "").lower().lstrip("@") in cfg.archive_channels:
                    owner = r["channel"]    # a reupload of a hermit's episode: still theirs
                if owner not in known:      # a collab upload from someone not in the roster
                    db.upsert_channel(conn, owner, None, info.get("channel"), info.get("channel_url"), None)
                    known[owner] = None
                db.upsert_video(conn, owner, meta)
                if need and not wanted:
                    db.set_error(conn, r["id"], None)
                elif need and not db.has_transcript(conn, r["id"]):
                    result = captions
                    budget_left = args.whisper_limit is None or whispered < args.whisper_limit
                    if result is None and whisper is not None and budget_left:
                        progress.update(task, description=f"[yellow]whisper[/] {(r['title'] or r['id'])[:42]}")
                        conn.commit()      # Whisper takes minutes: don't hold the write lock (and block builds) meanwhile
                        result = whisper.transcribe(r["id"], args.lang, False, _cookies(args))
                        whispered += 1
                    if result is None and not budget_left:
                        progress.console.print(f"[dim]whisper limit reached, next run:[/] {meta['title']}")
                        db.set_error(conn, r["id"], "whisper-wait")
                    elif result is None:
                        progress.console.print(f"[yellow]no transcript:[/] {meta['title']}")
                        db.set_error(conn, r["id"], "no-transcript")
                    else:
                        db.save_transcript(conn, r["id"], *result)
                        transcribed += 1
                done += 1
            except Exception as e:   # private, members-only, premiere not started...
                failed += 1
                msg = str(e).splitlines()[0]
                progress.console.print(f"[red]failed[/] {r['id']}: {msg[:150]}")
                if need:
                    db.set_error(conn, r["id"], msg[:500])
                bot = bot + 1 if "not a bot" in msg else 0
                if bot >= 5:
                    run["bot_check"] = True
                    for f in futures:
                        f.cancel()
                    progress.console.print(
                        "\n[red bold]YouTube is bot-checking this IP.[/] Stopped early; everything fetched so far is "
                        "saved. Wait an hour and re-run, or add [bold]--cookies-from-browser chromium[/] or [bold]--cookies FILE[/].")
                    break
            finally:
                conn.commit()
                progress.advance(task)
    run.update(processed=done, transcribed=transcribed, whispered=whispered, failed=failed)
    _record_sync(conn, run)
    console.print(f"\n[green]{done}[/] processed ({whispered} via Whisper), [red]{failed}[/] failed. "
                  f"Next: [bold]hermit-stats build[/]")
    return 0


def _record_sync(conn, run: dict) -> None:
    """Keep the run's summary for the site's status page."""
    db.set_kv(conn, "last_sync", {**run, "finished": int(time.time())})
    conn.commit()


# ---------------------------------------------------------------- import

def cmd_import(args) -> int:
    """Seed the database from a ytlex database, so its transcripts aren't fetched twice."""
    cfg = _cfg(args)
    conn = db.connect(args.db)
    src = sqlite3.connect(args.source)
    src.row_factory = sqlite3.Row
    by_url = {h.url.lower(): h for h in cfg.hermits}
    imported = 0
    for ch in src.execute("SELECT * FROM channels"):
        h = by_url.get((ch["url"] or "").lower().rstrip("/"))
        if not h:
            continue
        db.upsert_channel(conn, ch["id"], h.slug, ch["name"], h.url, None)
        for v in src.execute(
                """SELECT v.*, t.source, t.language, t.segments FROM videos v
                   JOIN transcripts t ON t.video_id = v.id WHERE v.channel = ?""", (ch["id"],)):
            colls = [c for c in cfg.collections if c.includes(h) and c.video_title and c.video_title.search(v["title"] or "")
                     and c.wants(v["title"], v["upload_date"])]
            if not colls:
                continue
            db.upsert_video(conn, ch["id"], {k: v[k] for k in v.keys()
                                             if k in ("id", "title", "description", "upload_date",
                                                      "duration", "view_count", "url")})
            if not db.has_transcript(conn, v["id"]):
                db.save_transcript(conn, v["id"], v["source"], v["language"], json.loads(v["segments"]))
            for c in colls:
                db.add_to_collection(conn, c.name, v["id"], "title")
            imported += 1
    conn.commit()
    console.print(f"Imported [bold]{imported}[/] transcribed videos. Their likes, comments and release times "
                  f"are filled in by the next [bold]hermit-stats sync[/].")
    return 0


# ---------------------------------------------------------------- build / serve / push

def cmd_build(args) -> int:
    cfg = _cfg(args)
    if args.season:
        unknown = set(args.season) - {c.name for c in cfg.collections}
        if unknown:
            console.print(f"[red]No such season: {', '.join(sorted(unknown))}[/]")
            return 1
        cfg.collections = [c for c in cfg.collections if c.name in args.season]
    conn = db.connect(args.db)
    t = time.time()
    r = builder.build(conn, cfg, args.out, log=console.print)
    console.print(f"Built [bold]{args.out}[/]: {r['videos']} videos, {r['hermits']} Hermits, "
                  f"{r['bytes'] / 1e6:.1f} MB in {time.time() - t:.0f}s")
    return 0


def cmd_serve(args) -> int:
    if not (args.out / "index.html").exists():
        console.print("[red]No site built yet: run hermit-stats build[/]")
        return 1
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(args.out))
    http.server.SimpleHTTPRequestHandler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    url = f"http://127.0.0.1:{args.port}/"
    console.print(f"Serving {args.out} at [bold]{url}[/] (Ctrl-C to stop)")
    if args.open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def cmd_push(args) -> int:
    cfg = _cfg(args)
    if not cfg.deploy_target:
        console.print("[red]Set [deploy] target in hermits.toml[/]")
        return 1
    if not shutil.which("rsync"):
        console.print("[red]rsync is not installed[/]")
        return 1
    # --delay-updates: files are swapped in at the end, so visitors never see a half-written data set.
    cmd = ["rsync", "-az", "--delete", "--delay-updates", "--chmod=D755,F644",
           f"{args.out}/", cfg.deploy_target]
    console.print("$ " + " ".join(cmd))
    rc = subprocess.run(cmd).returncode
    if rc == 0 and cfg.site_url:
        console.print(f"[green]Published[/] {cfg.site_url}")
    return rc


def cmd_status(args) -> int:
    conn = db.connect(args.db)
    t = Table("Collection", "Hermit", "Videos", "Transcribed")
    for r in db.status(conn):
        t.add_row(r["collection"], r["name"] or "?", str(r["videos"]), str(r["transcribed"]))
    console.print(t)
    return 0


def cmd_update(args) -> int:
    """sync + build + push: what the nightly timer runs."""
    for step in (cmd_sync, cmd_build, cmd_push):
        rc = step(args)
        if rc:
            return rc
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="hermit-stats", description=__doc__)
    p.add_argument("--db", type=Path, default=Path("hermit-stats.db"), help="SQLite database")
    p.add_argument("--config", type=Path, default=Path("hermits.toml"), help="roster / collections config")
    p.add_argument("--out", type=Path, default=Path("site"), help="where the static site is built")
    sub = p.add_subparsers(dest="cmd", required=True)

    def sync_args(s):
        s.add_argument("hermit", nargs="*", help="only these Hermits (name or handle); default all")
        s.add_argument("--no-discover", action="store_true", help="skip re-listing playlists")
        s.add_argument("--no-refresh", action="store_true", help="don't refresh recent videos' view counts")
        s.add_argument("--refresh-all", action="store_true", help="refresh metadata of every video")
        s.add_argument("--limit", type=int, help="transcribe at most N videos this run")
        s.add_argument("--workers", type=int, default=2, help="parallel metadata/caption fetches (default 2)")
        s.add_argument("--pause", type=float, nargs=2, default=(1.0, 3.0), metavar=("MIN", "MAX"),
                       help="random pause in seconds before each video fetch (default 1 3)")
        s.add_argument("--lang", default="en")
        s.add_argument("--whisper", choices=("fallback", "always", "never"), default="fallback",
                       help="local Whisper: only when a video has no captions (default), always, or never")
        s.add_argument("--whisper-limit", type=int, metavar="N",
                       help="Whisper at most N videos this run (newest first); the rest wait for the next run")
        s.add_argument("--model", default="large-v3-turbo", help="faster-whisper model")
        s.add_argument("--device", default="auto", help="whisper device: auto, cuda, cpu")
        s.add_argument("--cache", type=Path, default=Path("cache"), help="audio download dir for Whisper")
        s.add_argument("--cookies-from-browser", metavar="BROWSER",
                       help="use this browser's YouTube cookies if YouTube asks for sign-in")
        s.add_argument("--cookies", type=Path, metavar="FILE",
                       help="use cookies from this Netscape cookies.txt (for machines without a browser)")

    s = sub.add_parser("sync", help="find each Hermit's season videos and transcribe new ones")
    sync_args(s)
    s.set_defaults(fn=cmd_sync)

    s = sub.add_parser("import-ytlex", help="seed the database from a ytlex database")
    s.add_argument("source", type=Path)
    s.set_defaults(fn=cmd_import)

    s = sub.add_parser("build", help="analyse everything and write the static site")
    s.add_argument("--season", action="append", metavar="NAME",
                   help="only this season (repeatable), e.g. to publish seasons as a backfill finishes them")
    s.set_defaults(fn=cmd_build)

    s = sub.add_parser("serve", help="preview the built site locally")
    s.add_argument("--port", type=int, default=8650)
    s.add_argument("--open", action="store_true")
    s.set_defaults(fn=cmd_serve)

    s = sub.add_parser("push", help="upload the built site to the server")
    s.set_defaults(fn=cmd_push)

    s = sub.add_parser("update", help="sync, build and push in one go")
    sync_args(s)
    s.set_defaults(fn=cmd_update, season=None)    # build every season

    s = sub.add_parser("status", help="videos and transcripts per Hermit")
    s.set_defaults(fn=cmd_status)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
