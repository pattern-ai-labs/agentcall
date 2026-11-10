import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest


def load_reserve():
    path = Path(__file__).resolve().parents[1] / "scripts" / "python" / "reserve.py"
    spec = importlib.util.spec_from_file_location("agentcall_reserve_for_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


NOW = datetime(2026, 11, 9, 23, 58, 30, 123456, tzinfo=timezone.utc)


def test_relative_start_converts_to_utc_iso():
    reserve = load_reserve()
    assert reserve.parse_start("+10m", NOW) == "2026-11-10T00:08:30Z"
    assert reserve.parse_start("+2h", NOW) == "2026-11-10T01:58:30Z"
    assert reserve.parse_start("+1d", NOW) == "2026-11-10T23:58:30Z"
    assert reserve.parse_start(" +5m ", NOW) == "2026-11-10T00:03:30Z"


def test_absolute_start_passes_through():
    reserve = load_reserve()
    assert reserve.parse_start("2026-11-10T15:00:00Z", NOW) == "2026-11-10T15:00:00Z"


def test_bad_relative_start_is_rejected():
    reserve = load_reserve()
    for bad in ("+10", "+m", "+10s", "+1.5h"):
        with pytest.raises(ValueError):
            reserve.parse_start(bad, NOW)
