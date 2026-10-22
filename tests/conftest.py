import pytest


@pytest.fixture(autouse=True)
def no_live_tab(monkeypatch):
    """Discovery asks each channel's Live tab for its streams; tests that care set their own."""
    from hermitstats import youtube
    monkeypatch.setattr(youtube, "live_ids", lambda *a, **k: set())
