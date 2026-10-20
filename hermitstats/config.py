"""Load hermits.toml: the roster, how to find each season's videos, and where to publish."""

import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Collection:
    name: str
    playlist: re.Pattern
    video_title: re.Pattern | None
    skip: re.Pattern | None = None
    starts: str | None = None          # YYYYMMDD; earlier uploads are never in the collection
    teams: dict[str, list[str]] = field(default_factory=dict)   # team name -> member slugs

    def wants(self, title: str, upload_date: str | None = None) -> bool:
        if self.skip and self.skip.search(title or ""):
            return False
        return not (self.starts and upload_date and upload_date < self.starts)


@dataclass
class Hermit:
    name: str
    channel: str                       # @handle, bare channel id, or channel URL
    aliases: list[str]
    exclude: list[str] = field(default_factory=list)
    playlists: dict[str, str] = field(default_factory=dict)   # collection name -> playlist URL / id
    short: str = ""

    @property
    def slug(self) -> str:
        return re.sub(r"[^a-z0-9]+", "-", self.name.lower()).strip("-")

    @property
    def url(self) -> str:
        c = self.channel.strip()
        if c.startswith("http"):
            return c.rstrip("/")
        if c.startswith("UC") and len(c) == 24:
            return f"https://www.youtube.com/channel/{c}"
        return f"https://www.youtube.com/@{c.lstrip('@')}"


@dataclass
class Config:
    collections: list[Collection]
    hermits: list[Hermit]
    deploy_target: str | None
    site_url: str | None

    def collection(self, name: str) -> Collection:
        for c in self.collections:
            if c.name.lower() == name.lower():
                return c
        raise LookupError(name)

    def hermit(self, query: str) -> Hermit:
        q = query.lower().lstrip("@")
        for h in self.hermits:
            if q in (h.slug, h.name.lower(), h.channel.lower().lstrip("@")):
                return h
        raise LookupError(query)


def load(path: Path) -> Config:
    raw = tomllib.loads(path.read_text())
    collections = [
        Collection(c["name"], re.compile(c["playlist"], re.I),
                   re.compile(c["video_title"], re.I) if c.get("video_title") else None,
                   re.compile(c["skip"], re.I) if c.get("skip") else None,
                   c["starts"].replace("-", "") if c.get("starts") else None)
        for c in raw.get("collection", [])
    ]
    hermits = [Hermit(h["name"], h["channel"], [a.lower() for a in h.get("aliases", [])],
                      [e.lower() for e in h.get("exclude", [])], h.get("playlists", {}), h.get("short") or h["name"])
               for h in raw.get("hermit", [])]
    deploy = raw.get("deploy", {})
    cfg = Config(collections, hermits, deploy.get("target"), deploy.get("url"))
    for c, rc in zip(collections, raw.get("collection", [])):
        c.teams = {team: [cfg.hermit(m).slug for m in members] for team, members in rc.get("teams", {}).items()}
    return cfg
