import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from tabby_sdk import Client


class FakeBridge:
    def __init__(self, directory: str):
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(1)
        self.commands = []
        self.path = Path(directory) / "bridge.json"
        self.path.write_text(json.dumps({
            "host": "127.0.0.1",
            "port": self.server.getsockname()[1],
            "token": "test-token",
        }), encoding="utf-8")
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        connection, _ = self.server.accept()
        reader = connection.makefile("r", encoding="utf-8")
        for line in reader:
            message = json.loads(line)
            if "token" in message:
                response = {"id": message["id"], "ok": message["token"] == "test-token"}
            elif message["op"] == "list":
                response = {"id": message["id"], "ok": True, "terminals": [
                    {"id": "terminal-1", "title": "Local shell", "active": True},
                    {"id": "terminal-2", "title": "SSH", "active": False},
                ]}
            elif message["op"] == "connect":
                response = {"id": message["id"], "ok": True, "terminal":
                    {"id": message.get("terminal") or "terminal-1", "title": "Local shell", "active": True}}
            elif message["op"] == "send":
                self.commands.append(message["text"])
                response = {"id": message["id"], "ok": True}
                connection.sendall((json.dumps(response) + "\n").encode())
                connection.sendall((json.dumps({"event": "output", "data": "Python 3.12.1\r\n"}) + "\n").encode())
                continue
            else:
                response = {"id": message["id"], "ok": False, "error": "unexpected"}
            connection.sendall((json.dumps(response) + "\n").encode())

    def close(self):
        self.server.close()


class ClientTest(unittest.TestCase):
    def test_list_connect_send_and_expect(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = FakeBridge(directory)
            try:
                with Client(bridge.path) as client:
                    terminals = client.list_terminals()
                    self.assertEqual([item.title for item in terminals], ["Local shell", "SSH"])
                    self.assertTrue(terminals[0].active)
                    terminal = client.connect(terminals[0])
                    mark = terminal.mark()
                    terminal.send("python --version")
                    match = terminal.expect(r"Python\s+([\d.]+)", timeout=1, since=mark)
                    self.assertEqual(match.group(1), "3.12.1")
                    self.assertEqual(bridge.commands, ["python --version"])
            finally:
                bridge.close()


if __name__ == "__main__":
    unittest.main()
