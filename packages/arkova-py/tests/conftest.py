"""Select repo-source or installed-wheel imports for the Python SDK tests.

Ordinary checkout runs add ``src/`` to ``sys.path`` and need no installation.
CI and publication set ``ARKOVA_TEST_INSTALLED_WHEEL=1`` after installing the
built wheel; that mode fails before collection if Python resolves checkout
source instead of the installed artifact.
"""

import os
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SRC = PACKAGE_ROOT / "src"

if os.environ.get("ARKOVA_TEST_INSTALLED_WHEEL") == "1":
    import arkova

    imported = Path(arkova.__file__).resolve()
    if imported.is_relative_to(SRC) or "site-packages" not in imported.parts:
        raise RuntimeError(
            "ARKOVA_TEST_INSTALLED_WHEEL=1 requires arkova from site-packages; "
            f"resolved {imported}"
        )
elif str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
