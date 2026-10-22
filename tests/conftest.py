import pytest


@pytest.fixture(autouse=True)
def no_live_tab(monkeypatch):
    """Discovery asks each channel's Live and Shorts tabs; tests that care set their own."""
    from hermitstats import youtube
    monkeypatch.setattr(youtube, "not_episode_ids", lambda *a, **k: set())
