"""Disposable PostgreSQL test cluster; never connects to an existing database."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


class LocalPostgres:
    def __init__(self, output, binaries):
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.binaries = Path(binaries).resolve()
        self.data = self.output / "data"
        # Sonar python:S5443 — do not hardcode a world-writable directory.
        # `tempfile.gettempdir()` honours TMPDIR (a per-user, non-world-writable
        # path on macOS) and `ARKOVA_PG_SOCKET_DIR` lets an operator point at a
        # short path explicitly. The literal "/tmp" was only ever here because
        # a Unix socket path must fit in `sockaddr_un.sun_path`, so assert that
        # bound instead of hardcoding the shortest possible directory.
        socket_base = os.environ.get("ARKOVA_PG_SOCKET_DIR") or tempfile.gettempdir()
        self.socket = Path(tempfile.mkdtemp(prefix="arkova-pg-test-", dir=socket_base))
        sun_path = self.socket / ".s.PGSQL.55438"
        if len(str(sun_path).encode()) > 100:
            raise RuntimeError(
                f"Unix socket path {sun_path} exceeds the sun_path limit; "
                "set ARKOVA_PG_SOCKET_DIR to a shorter directory"
            )
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        self.env.update(
            PGHOST=str(self.socket),
            PGPORT="55438",
            PGUSER="postgres",
            PGDATABASE="postgres",
        )
        self.psql = [str(self.binaries / "psql"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1"]
        self.sessions = []

    def __enter__(self):
        initialized = subprocess.run(
            [
                str(self.binaries / "initdb"),
                "-D",
                str(self.data),
                "--auth=trust",
                "--no-locale",
                "-U",
                "postgres",
            ],
            capture_output=True,
            text=True,
        )
        (self.output / "initdb.log").write_text(initialized.stdout + initialized.stderr)
        if initialized.returncode:
            shutil.rmtree(self.socket)
            raise RuntimeError("Private initdb failed; inspect initdb.log")
        subprocess.run(
            [
                str(self.binaries / "pg_ctl"),
                "-D",
                str(self.data),
                "-l",
                str(self.output / "postgres.log"),
                "-o",
                f"-k {self.socket} -h '' -p 55438 -c shared_buffers=32MB -c statement_timeout=30000",
                "start",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return self

    def __exit__(self, *_):
        for session in self.sessions:
            session.close()
        subprocess.run(
            [str(self.binaries / "pg_ctl"), "-D", str(self.data), "stop", "-m", "fast"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        shutil.rmtree(self.socket)

    def query(self, sql, success=True):
        result = subprocess.run(
            self.psql + ["-c", sql],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=40,
        )
        if success and result.returncode:
            raise AssertionError(result.stderr)
        return result

    def value(self, sql):
        return json.loads(self.query(sql).stdout.strip().splitlines()[-1])

    def session(self, name):
        session = Session(self, name)
        self.sessions.append(session)
        return session

    def wait_for_lock(self, name):
        for _ in range(100):
            count = self.query(
                "SELECT count(*) FROM pg_stat_activity WHERE application_name="
                + quote(name)
                + " AND wait_event_type='Lock';"
            ).stdout.strip()
            if count == "1":
                return
            time.sleep(0.05)
        raise AssertionError("Expected an actual PostgreSQL lock wait: " + name)


class Session:
    def __init__(self, cluster, name):
        self.process = subprocess.Popen(
            cluster.psql,
            env={**cluster.env, "PGAPPNAME": name},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def write(self, sql):
        self.process.stdin.write(sql + "\n")
        self.process.stdin.flush()

    def read(self):
        line = self.process.stdout.readline()
        if not line:
            raise AssertionError(self.process.stderr.read())
        return line.strip()

    def close(self):
        if self.process.poll() is None:
            self.write("ROLLBACK;")
            self.process.stdin.close()
            self.process.wait(timeout=5)


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"
