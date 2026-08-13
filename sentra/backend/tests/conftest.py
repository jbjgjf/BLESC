"""Test-wide environment, set before any test module is imported.

`app.database` reads `DATABASE_URL` **once**, when it is first imported, and
builds its module-level engine from it. Any test module that imports `app.main`
therefore fixes the database for every module collected after it.

Until now this worked by alphabetical luck. The modules that set `DATABASE_URL`
before importing the app — `test_hf_research_benchmark`, `test_reflection_intelligence`,
`test_research_pipeline` — happen to sort before the modules that do not, so the
URL was always established first. Adding a module whose name sorts earlier
(`test_dynamics_endpoint`, #97) bound `app.database` to the default URL, and every
pipeline test that came after it failed with `no such table: entry`.

pytest imports `conftest.py` before collecting anything, so setting it here makes
the guarantee structural instead of a property of the filenames. The individual
modules keep their own assignments — they are harmless, they document the
dependency at the point it matters, and removing them would make this file
load-bearing in a way a reader of those modules could not see.
"""

import os

os.environ.setdefault("USE_MOCK_LLM", "true")
os.environ.setdefault("DATABASE_URL", "sqlite:///./test_research_pipeline.db")
