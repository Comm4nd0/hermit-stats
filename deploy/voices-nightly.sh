#!/bin/sh
# Who's talking, for new episodes: the build box can't run the voice model, so this runs on a machine that
# can (the desktop). It takes a fresh copy of the build box's database, voiceprints whatever is new, copies
# the `speech` rows back and rebuilds the site there. Settings in deploy/voices.env:
#   PROXMOX=root@192.168.1.201   the Proxmox host the build container runs on
#   CT=112                       the container
#   SEASONS="Season 10|Season 11"
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
. deploy/voices.env
remote() { ssh -o BatchMode=yes "$PROXMOX" "pct exec $CT -- su - hermit -c \"cd hermit-stats && $1\""; }
echo "== $(date '+%F %T') voices"

# Don't take a copy halfway through the build box's own nightly run.
for _ in $(seq 24); do
    remote "pgrep -u hermit -f 'hermit-stats [u]pdate' >/dev/null" || break
    echo "build box is mid-update; waiting"
    sleep 300
done

remote "sqlite3 hermit-stats.db '.backup /tmp/hs-copy.db'"
ssh "$PROXMOX" "pct pull $CT /tmp/hs-copy.db /tmp/hs-copy.db && pct exec $CT -- rm /tmp/hs-copy.db"
scp -q "$PROXMOX:/tmp/hs-copy.db" hermit-stats.db.new
ssh "$PROXMOX" rm /tmp/hs-copy.db
# Keep the speech rows only this machine has (a season not copied back yet): the rest is the build box's.
[ -f hermit-stats.db ] && sqlite3 hermit-stats.db ".mode insert speech" "SELECT * FROM speech" \
    | sed 's/^INSERT INTO/INSERT OR IGNORE INTO/' | sqlite3 hermit-stats.db.new
mv hermit-stats.db.new hermit-stats.db
rm -f hermit-stats.db-wal hermit-stats.db-shm

old_ifs=$IFS; IFS='|'
for s in $SEASONS; do
    IFS=$old_ifs
    uv run --no-sync hermit-stats voices "$s" || echo "voices $s failed; copying back what there is"
done
IFS=$old_ifs

# All of it, replacing the build box's: an episode left unsplit here (a dubbed track) loses its row there too.
{ echo "BEGIN; DELETE FROM speech;"
  sqlite3 hermit-stats.db ".mode insert speech" "SELECT * FROM speech"
  echo "COMMIT;"; } | gzip > logs/speech.sql.gz
scp -q logs/speech.sql.gz "$PROXMOX:/tmp/speech.sql.gz"
ssh "$PROXMOX" "pct push $CT /tmp/speech.sql.gz /tmp/speech.sql.gz && rm /tmp/speech.sql.gz && pct exec $CT -- chmod 644 /tmp/speech.sql.gz"
remote "zcat /tmp/speech.sql.gz | sqlite3 hermit-stats.db"
ssh "$PROXMOX" "pct exec $CT -- rm /tmp/speech.sql.gz"
remote "uv run hermit-stats build && uv run hermit-stats push"
echo "== $(date '+%F %T') done"
