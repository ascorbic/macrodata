---
"macrodata": patch
---

Roll the ambient-recall worker on plugin upgrade. The supervisor identified its
workers by state root alone, so a new version adopted the previous version's
running worker and logged it as healthy — an installed release could serve recall
from code it does not contain, with no visible symptom. It now classifies each
worker by the source path in its argv: this version's stays up, another plugin
version's is reaped (SIGTERM escalating to SIGKILL, then verified) and respawned,
and a hand-started dev worker keeps running but is announced instead of passed
over in silence.
