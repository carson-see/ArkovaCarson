"""Make `src/arkova` importable when running pytest from a repo checkout
(without `pip install -e .`). Published-package behaviour is unchanged."""

import os
import sys

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)
