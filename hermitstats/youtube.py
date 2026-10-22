"""Channel playlists, playlist / upload listings, and per-video metadata via yt-dlp."""

import io
import time
from dataclasses import dataclass
from pathlib import Path

import yt_dlp


@dataclass(frozen=True)
class Cookies:
    """YouTube cookies for when it asks for sign-in: from a browser, or from an exported cookies.txt."""
    browser: str | None = None
    file: Path | None = None

    def opts(self) -> dict:
        if self.browser:
            return {"cookiesfrombrowser": (self.browser,)}
        if self.file:
            # A fresh in-memory copy for each YoutubeDL: yt-dlp writes cookies back on close (not atomically),
            # so parallel workers sharing the file would clobber it.
            return {"cookiefile": io.StringIO(self.file.read_text())}
        return {}


def _ydl(extra: dict | None = None, cookies: Cookies | None = None) -> yt_dlp.YoutubeDL:
    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    if cookies:
        opts.update(cookies.opts())
    opts.update(extra or {})
    return yt_dlp.YoutubeDL(opts)


def _flat_entry(e: dict) -> dict:
    return {
        "id": e["id"],
        "title": e.get("title"),
        "upload_date": e.get("upload_date"),
        "timestamp": e.get("timestamp") or e.get("release_timestamp"),
        "duration": e.get("duration"),
        "view_count": e.get("view_count"),
        "url": f"https://www.youtube.com/watch?v={e['id']}",
        "channel_id": e.get("channel_id"),
        "uploader_id": e.get("uploader_id"),
    }


def _avatar(info: dict) -> str | None:
    """The channel avatar is the square thumbnail; banners are wide."""
    square = [t for t in info.get("thumbnails") or []
              if t.get("width") and t.get("width") == t.get("height")]
    if square:
        return max(square, key=lambda t: t["width"])["url"]
    for t in info.get("thumbnails") or []:
        if "avatar" in str(t.get("id")):
            return t["url"]
    return None


def channel_playlists(channel_url: str, cookies: Cookies | None = None) -> dict:
    """{id, name, avatar_url, playlists: [(playlist_id, title)]} from the channel's Playlists tab."""
    with _ydl({"extract_flat": "in_playlist"}, cookies) as ydl:
        info = ydl.extract_info(f"{channel_url}/playlists", download=False)
    return {
        "id": info.get("channel_id") or info.get("id"),
        "name": info.get("channel") or info.get("uploader") or info.get("title"),
        "avatar_url": _avatar(info),
        "playlists": [(e["id"], e.get("title") or "") for e in info.get("entries") or [] if e and e.get("id")],
    }


def list_playlist(playlist_id: str, cookies: Cookies | None = None) -> list[dict]:
    with _ydl({"extract_flat": "in_playlist"}, cookies) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/playlist?list={playlist_id}", download=False)
    seen, out = set(), []
    for e in info.get("entries") or []:
        if e and e.get("id") and e["id"] not in seen:
            seen.add(e["id"])
            out.append(_flat_entry(e))
    return out


class _Silent:
    """yt-dlp logger that drops everything; failures still raise DownloadError."""
    def debug(self, msg): pass
    warning = error = debug


def list_uploads(channel_url: str, tabs=("videos", "streams"), latest: int | None = None,
                 cookies: Cookies | None = None) -> list[dict]:
    """The channel's uploads, newest first per tab; `latest` stops after that many per tab."""
    out: dict[str, dict] = {}
    with _ydl({"extract_flat": "in_playlist", "playlistend": latest, "logger": _Silent()},
              cookies) as ydl:
        for tab in tabs:
            try:
                info = ydl.extract_info(f"{channel_url}/{tab}", download=False)
            except yt_dlp.utils.DownloadError as e:
                if "does not have a" in str(e):   # channel has no streams tab
                    continue
                raise
            for e in info.get("entries") or []:
                if e and e.get("id") and e["id"] not in out:
                    out[e["id"]] = _flat_entry(e)
    return list(out.values())


def not_episode_ids(channel_url: str, cookies: Cookies | None = None) -> set[str]:
    """Every past stream on the channel's Live tab and every Short on its Shorts tab."""
    return {v["id"] for v in list_uploads(channel_url, tabs=("streams", "shorts"), cookies=cookies)}


def fetch_details(video_id: str, cookies: Cookies | None = None) -> tuple[dict, dict]:
    """Full metadata for one video. Returns (row for the db, raw yt-dlp info) — the raw info carries
    the caption track URLs, so the caller reuses it for the transcript."""
    with _ydl(cookies=cookies) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    return {
        "id": video_id,
        "title": info.get("title"),
        "description": info.get("description"),
        "upload_date": info.get("upload_date"),
        "timestamp": info.get("release_timestamp") or info.get("timestamp"),
        "duration": info.get("duration"),
        "view_count": info.get("view_count"),
        "like_count": info.get("like_count"),
        "comment_count": info.get("comment_count"),
        "url": info.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}",
        "details_at": int(time.time()),
    }, info
