"""Control terminals opened in Tabby from an external Python process."""

from .client import (
    Client,
    ConnectionError,
    ProtocolError,
    TabbyError,
    Terminal,
    TerminalInfo,
    connect,
    list_terminals,
)

__all__ = [
    "Client",
    "ConnectionError",
    "ProtocolError",
    "TabbyError",
    "Terminal",
    "TerminalInfo",
    "connect",
    "list_terminals",
]
