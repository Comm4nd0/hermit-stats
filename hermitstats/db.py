"""SQLite store: channels, videos, transcripts, and which collection (season) each video belongs to."""

import json
import sqlite3
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
    details_at    INTEGER             -- when full metadata was last fetched
);
CREATE TABLE IF NOT EXISTS transcripts (
    video_id  TEXT PRIMARY KEY REFERENCES videos(id),
    source    TEXT NOT NULL,          -- 'manual-captions' | 'auto-captions' | 'whisper'
    language  TEXT,
    text      TEXT NOT NULL,
    segments  TEXT NOT NULL           -- JSON list of {start, end, text}
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
"""

_VIDEO_COLS = ("title", "description", "upload_date", "timestamp", "duration", "view_count",
               "like_count", "comment_count", "url", "details_at")


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")   # build can read while a sync is writing
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
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
    conn.execute("INSERT OR IGNORE INTO collection_videos (collection, video_id, via) VALUES (?, ?, ?)",
                 (collection, video_id, via))


def has_transcript(conn, video_id: str) -> bool:
    return conn.execute("SELECT 1 FROM transcripts WHERE video_id = ?", (video_id,)).fetchone() is not None


def save_transcript(conn, video_id: str, source: str, language: str | None, segments: list[dict]) -> None:
    text = " ".join(s["text"].strip() for s in segments if s["text"].strip())
    conn.execute(
        "INSERT OR REPLACE INTO transcripts (video_id, source, language, text, segments) VALUES (?, ?, ?, ?, ?)",
        (video_id, source, language, text, json.dumps(segments)),
    )


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


def analysable(conn) -> list[dict]:
    """Every transcribed collection video, with its hermit slug and collection list."""
    rows = conn.execute(
        """SELECT v.*, c.hermit, t.source, t.text, t.segments, GROUP_CONCAT(cv.collection, '|') AS collections
           FROM videos v
           JOIN channels c ON c.id = v.channel
           JOIN transcripts t ON t.video_id = v.id
           JOIN collection_videos cv ON cv.video_id = v.id
           WHERE c.hermit IS NOT NULL
           GROUP BY v.id ORDER BY v.upload_date, v.timestamp"""
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["collections"] = sorted(set(d["collections"].split("|")))
        out.append(d)
    return out


def status(conn) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT c.hermit, c.name, cv.collection, COUNT(DISTINCT cv.video_id) AS videos,
                  COUNT(DISTINCT t.video_id) AS transcribed
           FROM channels c JOIN videos v ON v.channel = c.id
           JOIN collection_videos cv ON cv.video_id = v.id
           LEFT JOIN transcripts t ON t.video_id = v.id
           GROUP BY c.id, cv.collection ORDER BY cv.collection, c.name"""
    ).fetchall()
