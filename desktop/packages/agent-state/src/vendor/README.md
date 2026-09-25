# Vendored from esp32-agent-companion

`protocol.ts`, `state-coordinator.ts` and `state-store.ts` are taken unmodified
from https://github.com/DanWahlin/esp32-agent-companion (`daemon/src/`), with
`state-coordinator.test.ts` and `state-store.test.ts` from that repository's
`daemon/test/` kept alongside so the vendored copies stay verified.

Copyright belongs to Dan Wahlin, who has approved this derivative work. That
repository still carries no LICENSE file, so that approval is what permits
redistribution - see the licensing note in the root README.

The two vendored tests are changed in exactly two ways, both unavoidable: their
imports point at this folder, and the file-mode assertions in
`state-store.test.ts` are skipped on Windows, where `chmod` cannot set POSIX
bits. The sources themselves are unmodified; the transport,
the socket paths and the hook installer are ours and live outside this folder,
because upstream's are USB- and Copilot-CLI-specific and have no Windows path.
