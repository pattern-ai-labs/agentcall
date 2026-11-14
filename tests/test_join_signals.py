import asyncio
import importlib.util
import io
import sys
from pathlib import Path


def load_join():
    scripts = Path(__file__).resolve().parents[1] / "scripts" / "python"
    sys.path.insert(0, str(scripts))  # join.py imports agentcall and tunnel as siblings
    spec = importlib.util.spec_from_file_location("agentcall_join_for_test", scripts / "join.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeClient:
    instances = []

    def __init__(self, api_key, base_url):
        self.closed = False
        FakeClient.instances.append(self)

    async def create_call(self, **params):
        return {"call_id": "call_test", "status": "joining"}

    async def connect_ws(self, call_id):
        yield {"event": "call.ended", "reason": "left"}

    async def send_command(self, command):
        pass

    async def close(self):
        self.closed = True


def no_signal_handlers(sig, callback):
    # What Windows' event loops (Proactor and Selector) do.
    raise NotImplementedError


def prepare(monkeypatch, tmp_path):
    join = load_join()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("AGENTCALL_API_KEY", "test-key")
    monkeypatch.setattr(sys, "argv", ["join.py", "https://meet.google.com/abc-defg-hij"])
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))
    monkeypatch.setattr(join, "AgentCallClient", FakeClient)
    return join


def test_join_runs_on_event_loops_without_signal_handlers(monkeypatch, tmp_path):
    join = prepare(monkeypatch, tmp_path)

    async def run():
        asyncio.get_running_loop().add_signal_handler = no_signal_handlers
        await join.main()

    asyncio.run(run())

    # The call ran to its end: the client was closed and the crash-recovery
    # state file was removed, so the next run does not "recover" a dead call.
    assert FakeClient.instances[-1].closed
    assert not (tmp_path / join.STATE_FILE).exists()


def test_join_still_installs_both_signal_handlers_where_supported(monkeypatch, tmp_path):
    # Linux / macOS: SIGINT and SIGTERM keep triggering the graceful shutdown.
    join = prepare(monkeypatch, tmp_path)
    installed = {}
    shutdowns = []

    async def fake_shutdown(client, tunnel_client):
        shutdowns.append(client)

    monkeypatch.setattr(join, "_shutdown", fake_shutdown)

    async def run():
        asyncio.get_running_loop().add_signal_handler = lambda sig, cb: installed.__setitem__(sig, cb)
        await join.main()
        installed[join.signal.SIGTERM]()  # what the loop does when the signal arrives
        await asyncio.sleep(0)

    asyncio.run(run())

    assert set(installed) == {join.signal.SIGINT, join.signal.SIGTERM}
    assert shutdowns == [FakeClient.instances[-1]]
