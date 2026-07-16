"""Dependency-free client for the tabby-command-editor loopback bridge."""

import json
import os
import queue
import re
import socket
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Pattern, Union


class TabbyError(RuntimeError):
    """Base SDK error."""


class ConnectionError(TabbyError):
    """Tabby or its command-editor bridge could not be reached."""


class ProtocolError(TabbyError):
    """The bridge rejected a request or returned invalid data."""


@dataclass(frozen=True)
class TerminalInfo:
    """A terminal currently opened in Tabby."""

    id: str
    title: str
    active: bool = False


def _default_discovery_path() -> Path:
    configured = os.environ.get("TABBY_COMMAND_EDITOR_BRIDGE")
    if configured:
        return Path(configured).expanduser()
    suffix = ""
    if hasattr(os, "getuid"):
        suffix = "-{}".format(os.getuid())
    return Path(tempfile.gettempdir()) / "tabby-command-editor-bridge{}.json".format(suffix)


class Client:
    """A connection to the Tabby application.

    The bridge address and authentication token are discovered automatically.
    Use the class as a context manager when practical.
    """

    def __init__(self, discovery_path: Optional[Union[str, os.PathLike]] = None, timeout: float = 5.0):
        self._path = Path(discovery_path) if discovery_path else _default_discovery_path()
        self._timeout = float(timeout)
        self._socket: Optional[socket.socket] = None
        self._reader = None
        self._thread: Optional[threading.Thread] = None
        self._closed = False
        self._next_id = 0
        self._send_lock = threading.Lock()
        self._pending: Dict[int, "queue.Queue[Dict[str, Any]]"] = {}
        self._pending_lock = threading.Lock()
        self._terminal: Optional["Terminal"] = None
        self._open()

    def _open(self) -> None:
        try:
            descriptor = json.loads(self._path.read_text(encoding="utf-8"))
            host = descriptor["host"]
            port = int(descriptor["port"])
            token = descriptor["token"]
        except FileNotFoundError as error:
            raise ConnectionError(
                "Tabby bridge not found. Start Tabby with tabby-command-editor installed."
            ) from error
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError) as error:
            raise ConnectionError("Invalid Tabby bridge descriptor: {}".format(self._path)) from error

        try:
            sock = socket.create_connection((host, port), timeout=self._timeout)
            sock.settimeout(self._timeout)
            reader = sock.makefile("r", encoding="utf-8", newline="\n")
            sock.sendall((json.dumps({"id": 0, "token": token}) + "\n").encode("utf-8"))
            line = reader.readline()
            response = json.loads(line)
            if not response.get("ok"):
                raise ConnectionError(response.get("error", "Tabby bridge authentication failed"))
            sock.settimeout(None)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise ConnectionError("Could not connect to the Tabby bridge") from error

        self._socket = sock
        self._reader = reader
        self._thread = threading.Thread(target=self._receive, name="tabby-sdk-receiver", daemon=True)
        self._thread.start()

    def list_terminals(self) -> List[TerminalInfo]:
        """Return all terminal tabs, including terminals inside split tabs."""
        response = self._request("list")
        return [TerminalInfo(str(item["id"]), str(item["title"]), bool(item.get("active")))
                for item in response.get("terminals", [])]

    def connect(self, terminal: Optional[Union[str, TerminalInfo]] = None) -> "Terminal":
        """Bind this client to a terminal; defaults to the active terminal."""
        terminal_id = terminal.id if isinstance(terminal, TerminalInfo) else terminal
        response = self._request("connect", terminal=terminal_id)
        item = response["terminal"]
        info = TerminalInfo(str(item["id"]), str(item["title"]), bool(item.get("active")))
        self._terminal = Terminal(self, info)
        return self._terminal

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._socket is not None:
            try:
                self._socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self._socket.close()
        if self._reader is not None:
            try:
                self._reader.close()
            except OSError:
                pass
        self._fail_pending(ConnectionError("Tabby connection closed"))

    def __enter__(self) -> "Client":
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()

    def _request(self, operation: str, **values: Any) -> Dict[str, Any]:
        if self._closed or self._socket is None:
            raise ConnectionError("Tabby connection is closed")
        with self._send_lock:
            self._next_id += 1
            request_id = self._next_id
            response_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=1)
            with self._pending_lock:
                self._pending[request_id] = response_queue
            message = {"id": request_id, "op": operation}
            message.update(values)
            try:
                self._socket.sendall((json.dumps(message) + "\n").encode("utf-8"))
            except OSError as error:
                with self._pending_lock:
                    self._pending.pop(request_id, None)
                raise ConnectionError("Could not write to the Tabby bridge") from error

        try:
            response = response_queue.get(timeout=self._timeout)
        except queue.Empty as error:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            raise ConnectionError("Tabby bridge request timed out") from error
        if "_exception" in response:
            raise response["_exception"]
        if not response.get("ok"):
            raise ProtocolError(str(response.get("error", "Tabby bridge request failed")))
        return response

    def _receive(self) -> None:
        try:
            while not self._closed and self._reader is not None:
                line = self._reader.readline()
                if not line:
                    break
                message = json.loads(line)
                if message.get("event") == "output":
                    terminal = self._terminal
                    if terminal is not None:
                        terminal._append(str(message.get("data", "")))
                    continue
                request_id = message.get("id")
                with self._pending_lock:
                    response_queue = self._pending.pop(request_id, None)
                if response_queue is not None:
                    response_queue.put(message)
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        finally:
            if not self._closed:
                self._closed = True
                self._fail_pending(ConnectionError("Tabby bridge disconnected"))

    def _fail_pending(self, error: Exception) -> None:
        with self._pending_lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for response_queue in pending:
            response_queue.put({"_exception": error})


class Terminal:
    """The tabby-style API bound to one terminal."""

    def __init__(self, client: Client, info: TerminalInfo):
        self.client = client
        self.info = info
        self._text = ""
        self._base = 0
        self._cursor = 0
        self._max_chars = 1024 * 1024
        self._condition = threading.Condition()

    @property
    def id(self) -> str:
        return self.info.id

    @property
    def title(self) -> str:
        return self.info.title

    def send(self, text: Any) -> None:
        """Send one or more commands to the connected terminal."""
        self.client._request("send", text=str(text))

    def mark(self) -> int:
        with self._condition:
            return self._base + len(self._text)

    def clear(self) -> int:
        with self._condition:
            self._cursor = self._base + len(self._text)
            return self._cursor

    def tail(self, last: int = 4096) -> str:
        with self._condition:
            return self._text[-max(0, int(last)):]

    def read(self, timeout: float = 0) -> str:
        deadline = time.monotonic() + max(0, float(timeout))
        with self._condition:
            while self._cursor >= self._base + len(self._text):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return ""
                self._condition.wait(remaining)
            result = self._text[max(0, self._cursor - self._base):]
            self._cursor = self._base + len(self._text)
            return result

    def expect(
        self,
        pattern: Union[str, Pattern[str]],
        timeout: float = 5,
        since: Optional[int] = None,
        flags: int = 0,
    ) -> "re.Match[str]":
        expression = re.compile(pattern, flags) if isinstance(pattern, str) else pattern
        start = self._cursor if since is None else max(0, int(since))
        deadline = time.monotonic() + max(0, float(timeout))
        with self._condition:
            while True:
                match = expression.search(self._text, max(0, start - self._base))
                if match:
                    self._cursor = self._base + match.end()
                    return match
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        "terminal expect timed out: {!r}\n--- terminal tail ---\n{}".format(
                            pattern, self._text[-4000:]
                        )
                    )
                self._condition.wait(remaining)

    def close(self) -> None:
        self.client.close()

    def _append(self, data: str) -> None:
        text = data.replace("\r\n", "\n").replace("\r", "\n")
        with self._condition:
            self._text += text
            excess = len(self._text) - self._max_chars
            if excess > 0:
                self._text = self._text[excess:]
                self._base += excess
                self._cursor = max(self._cursor, self._base)
            self._condition.notify_all()

    def __enter__(self) -> "Terminal":
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()


def list_terminals(timeout: float = 5.0) -> List[TerminalInfo]:
    """Convenience function that opens a short-lived client and lists terminals."""
    with Client(timeout=timeout) as client:
        return client.list_terminals()


def connect(
    terminal: Optional[Union[str, TerminalInfo]] = None,
    timeout: float = 5.0,
) -> Terminal:
    """Connect to a terminal and return its tabby-style API object."""
    client = Client(timeout=timeout)
    try:
        return client.connect(terminal)
    except Exception:
        client.close()
        raise
