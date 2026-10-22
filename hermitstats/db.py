"""SQLite store: channels, videos, transcripts, and which collection (season) each video belongs to."""

import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS channels (
    id         TEXT PRIMARY KEY,
    hermit     TEXT,                  -- hermit slug from hermits.toml
    name       TEXT,
    url        TEXT,
    avatar_url TEXT
);
CREATE TABLE IF NOT EXISTS videos (
    id            TEXT PRIMARY KEY,
    channel       TEXT NOT NULL,
    title         TEXT,
    description   TEXT,
    upload_date   TEXT,               -- YYYYMMDD
    timestamp     INTEGER,            -- release time (unix), when known
    duration      REAL,
    view_count    INTEGER,
    like_count    INTEGER,
    comment_count INTEGER,
    url           TEXT,
    details_at    INTEGER,            -- when full metadata was last fetched
    error         TEXT,               -- why the last fetch didn't give a transcript (cleared on success)
    error_at      INTEGER
);
CREATE TABLE IF NOT EXISTS transcripts (
    video_id  TEXT PRIMARY KEY REFERENCES videos(id),
    source    TEXT NOT NULL,          -- 'manual-captions' | 'auto-captions' | 'whisper'
    language  TEXT,
    text      TEXT NOT NULL,
    segments  TEXT NOT NULL,          -- JSON list of {start, end, text}
    added_at  INTEGER                 -- when it was saved: what "new since your last visit" goes by
);
CREATE TABLE IF NOT EXISTS playlists (
    id         TEXT PRIMARY KEY,
    channel    TEXT,
    title      TEXT,
    collection TEXT
);
-- A video is in a collection because one of its channel's matching playlists holds it ('playlist:<id>'),
-- or because its title matched the collection's video_title pattern ('title').
CREATE TABLE IF NOT EXISTS collection_videos (
    collection TEXT NOT NULL,
    video_id   TEXT NOT NULL REFERENCES videos(id),
    via        TEXT NOT NULL,
    PRIMARY KEY (collection, video_id)
);
-- Small facts about the last runs ('last_sync' -> JSON), shown on the site's status page.
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

# Columns added after the first release: (table, column, type). connect() adds any that are missing.
_ADDED = (("videos", "error", "TEXT"), ("videos", "error_at", "INTEGER"), ("transcripts", "added_at", "INTEGER"))

_VIDEO_COLS = ("title", "description", "upload_date", "timestamp", "duration", "view_count",
               "like_count", "comment_count", "url", "details_at")


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")   # build can read while a sync is writing
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    for table, col, typ in _ADDED:
        if col not in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
    return conn


def upsert_channel(conn, channel_id: str, hermit: str, name: str, url: str, avatar_url: str | None) -> None:
    conn.execute(
        """INSERT INTO channels (id, hermit, name, url, avatar_url) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET hermit=excluded.hermit, name=excluded.name, url=excluded.url,
             avatar_url=COALESCE(excluded.avatar_url, channels.avatar_url)""",
        (channel_id, hermit, name, url, avatar_url),
    )


def upsert_video(conn, channel: str, v: dict) -> None:
    """Insert or update a video. Missing / None fields never overwrite known values."""
    row = {"id": v["id"], "channel": channel, **{c: v.get(c) for c in _VIDEO_COLS}}
    updates = ", ".join(f"{c}=COALESCE(excluded.{c}, videos.{c})" for c in _VIDEO_COLS)
    conn.execute(
        f"""INSERT INTO videos (id, channel, {', '.join(_VIDEO_COLS)})
            VALUES (:id, :channel, {', '.join(':' + c for c in _VIDEO_COLS)})
            ON CONFLICT(id) DO UPDATE SET channel=excluded.channel, {updates}""",
        row,
    )


def upsert_playlist(conn, playlist_id: str, channel: str, title: str, collection: str) -> None:
    conn.execute(
        """INSERT INTO playlists (id, channel, title, collection) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET channel=excluded.channel, title=excluded.title,
             collection=excluded.collection""",
        (playlist_id, channel, title, collection),
    )


def add_to_collection(conn, collection: str, video_id: str, via: str) -> None:
    """A video first found by its title that turns up in a playlist later is recorded as the playlist's."""
    conn.execute(
        """INSERT INTO collection_videos (collection, video_id, via) VALUES (?, ?, ?)
           ON CONFLICT(collection, video_id) DO UPDATE SET via = excluded.via
           WHERE excluded.via LIKE 'playlist:%' AND collection_videos.via NOT LIKE 'playlist:%'""",
        (collection, video_id, via))


def has_transcript(conn, video_id: str) -> bool:
    return conn.execute("SELECT 1 FROM transcripts WHERE video_id = ?", (video_id,)).fetchone() is not None


def save_transcript(conn, video_id: str, source: str, language: str | None, segments: list[dict]) -> None:
    text = " ".join(s["text"].strip() for s in segments if s["text"].strip())
    conn.execute(
        """INSERT OR REPLACE INTO transcripts (video_id, source, language, text, segments, added_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (video_id, source, language, text, json.dumps(segments), int(time.time())),
    )
    set_error(conn, video_id, None)


def set_error(conn, video_id: str, error: str | None) -> None:
    """Why a video still has no transcript ('whisper-wait', 'no-transcript', or the fetch error); None clears it."""
    conn.execute("UPDATE videos SET error = ?, error_at = ? WHERE id = ?",
                 (error, int(time.time()) if error else None, video_id))


def get_kv(conn, key: str):
    row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else None


def set_kv(conn, key: str, value) -> None:
    conn.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", (key, json.dumps(value)))


def pending(conn, collection: str | None = None) -> list[sqlite3.Row]:
    """Collection videos still missing full metadata or a transcript."""
    sql = """SELECT DISTINCT v.* FROM videos v JOIN collection_videos cv ON cv.video_id = v.id
             LEFT JOIN transcripts t ON t.video_id = v.id
             WHERE (t.video_id IS NULL OR v.details_at IS NULL)"""
    args = []
    if collection:
        sql += " AND cv.collection = ?"
        args.append(collection)
    return conn.execute(sql + " ORDER BY v.upload_date DESC", args).fetchall()


def untried(conn, collection: str) -> int:
    """Collection videos never fetched yet: no transcript and no error from an attempt."""
    return conn.execute(
        """SELECT COUNT(*) FROM collection_videos cv JOIN videos v ON v.id = cv.video_id
           LEFT JOIN transcripts t ON t.video_id = v.id
           WHERE cv.collection = ? AND t.video_id IS NULL AND v.error IS NULL""", (collection,)).fetchone()[0]


def analysable(conn, collection: str):
    """The collection's transcribed videos with their hermit slug and every collection they're in, one hermit
    after another. A generator: a season's transcripts are never all in memory at once."""
    for r in conn.execute(
        """SELECT v.*, c.hermit, t.source, t.text, t.segments, t.added_at,
                  (SELECT GROUP_CONCAT(collection, '|') FROM collection_videos WHERE video_id = v.id) AS collections
           FROM videos v
           JOIN channels c ON c.id = v.channel
           JOIN transcripts t ON t.video_id = v.id
           WHERE c.hermit IS NOT NULL AND v.id IN (SELECT video_id FROM collection_videos WHERE collection = ?)
           ORDER BY c.hermit, v.upload_date, v.timestamp""", (collection,)):
        d = dict(r)
        d["collections"] = sorted(set(d["collections"].split("|")))
        yield d


def upload_dates(conn, collection: str) -> list[str]:
    """Upload dates of the collection's transcribed videos (cheap: no transcript text)."""
    return [r[0] for r in conn.execute(
        """SELECT v.upload_date FROM videos v JOIN transcripts t ON t.video_id = v.id
           WHERE v.upload_date IS NOT NULL AND v.id IN (SELECT video_id FROM collection_videos WHERE collection = ?)""",
        (collection,))]


def status(conn) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT c.hermit, c.name, cv.collection, COUNT(DISTINCT cv.video_id) AS videos,
                  COUNT(DISTINCT t.video_id) AS transcribed
           FROM channels c JOIN videos v ON v.channel = c.id
           JOIN collection_videos cv ON cv.video_id = v.id
           LEFT JOIN transcripts t ON t.video_id = v.id
           GROUP BY c.id, cv.collection ORDER BY cv.collection, c.name"""
    ).fetchall()


def waiting(conn) -> list[dict]:
    """Collection videos with no transcript yet, with their hermit, collections and last error."""
    rows = conn.execute(
        """SELECT v.id, v.title, v.upload_date, v.details_at, v.error, v.error_at, c.hermit,
                  GROUP_CONCAT(cv.collection, '|') AS collections
           FROM videos v JOIN channels c ON c.id = v.channel
           JOIN collection_videos cv ON cv.video_id = v.id
           LEFT JOIN transcripts t ON t.video_id = v.id
           WHERE t.video_id IS NULL AND c.hermit IS NOT NULL
           GROUP BY v.id ORDER BY v.upload_date DESC"""
    ).fetchall()
    return [{**dict(r), "collections": sorted(set(r["collections"].split("|")))} for r in rows]


def unlisted(conn) -> list[sqlite3.Row]:
    """Videos found only by their title although their channel has a playlist for that collection: episodes
    the creator left out of their season playlist."""
    return conn.execute(
        """SELECT v.id, v.title, v.upload_date, c.hermit, cv.collection
           FROM collection_videos cv JOIN videos v ON v.id = cv.video_id JOIN channels c ON c.id = v.channel
           WHERE cv.via = 'title' AND c.hermit IS NOT NULL
             AND EXISTS (SELECT 1 FROM playlists p WHERE p.channel = v.channel AND p.collection = cv.collection)
           ORDER BY c.hermit, v.upload_date"""
    ).fetchall()
