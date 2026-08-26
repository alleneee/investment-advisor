from __future__ import annotations

import threading
from collections.abc import Callable, Sequence

import psycopg


class DurableJobWorker:
    def __init__(
        self,
        recoveries: Sequence[Callable[[], None]],
        *,
        interval_seconds: float = 1.0,
    ) -> None:
        if interval_seconds <= 0:
            raise ValueError("interval_seconds 必须大于 0")
        self.recoveries = tuple(recoveries)
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.is_running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=max(self.interval_seconds * 2, 1.0))
        self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            for recovery in self.recoveries:
                if self._stop.is_set():
                    return
                try:
                    recovery()
                except (RuntimeError, TypeError, ValueError, psycopg.Error):
                    pass
            self._stop.wait(self.interval_seconds)
