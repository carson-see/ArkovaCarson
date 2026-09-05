#!/usr/bin/env python3
"""Launch a command in its OWN session (setsid), immune to process-group kills.

The batch-A supervisors were previously started with `nohup ... &`. nohup only
ignores SIGHUP; it does NOT move the child out of the caller's process group, so
when the launching harness kills its group the supervisor dies with it. That is
the exact mechanism that leaves a window hollow: the driver finishes its current
cycle, nothing starts the next, and the log simply stops with no error.

Double-fork + os.setsid() detaches into a brand new session with no controlling
terminal, so the supervisor survives the caller's exit and is reparented to init.
"""
import os, sys

log = sys.argv[1]
cmd = sys.argv[2:]
if not cmd:
    sys.exit("usage: detach.py <logfile> <command...>")

if os.fork() > 0:
    sys.exit(0)          # parent returns immediately
os.setsid()              # NEW SESSION — the point of this script
if os.fork() > 0:
    os._exit(0)          # ensure we can never reacquire a controlling terminal

fd = os.open(os.devnull, os.O_RDONLY)
os.dup2(fd, 0)
out = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(out, 1)
os.dup2(out, 2)
os.execvp(cmd[0], cmd)
