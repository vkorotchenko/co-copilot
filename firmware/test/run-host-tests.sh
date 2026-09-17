#!/usr/bin/env bash
# Host tests for session pals, the completion latch, and wake input arbitration.
#
#   firmware/test/run-host-tests.sh
#
# The decision helpers are deliberately free of Arduino/M5 dependencies, so the logic
# that decides what the device parses and shows can be compiled and asserted on
# a laptop. This is a plain compiler + assert harness on purpose: no Unity, no
# new test framework, no extra PlatformIO environment.
#
# ArduinoJson is header-only and already vendored by PlatformIO. If the libdeps
# directory is missing, run `cd firmware && pio run` once to populate it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
firmware="$(dirname "$here")"
root="$(dirname "$firmware")"

json="$firmware/.pio/libdeps/m5dial/ArduinoJson/src"
if [[ ! -d "$json" ]]; then
  echo "ArduinoJson headers not found at $json" >&2
  echo "Run 'cd firmware && pio run' once to fetch dependencies." >&2
  exit 2
fi

out="$firmware/.pio/host-tests"
mkdir -p "$out"

cxx="${CXX:-c++}"
"$cxx" -std=c++17 -O1 -Wall -Wextra -Wno-unused-parameter \
  -I"$firmware/src" -I"$json" \
  "$here/host/test_session_pals.cpp" -o "$out/test_session_pals"

"$out/test_session_pals" "$root"
"$cxx" -std=c++17 -O1 -Wall -Wextra -Wno-unused-parameter \
  -I"$firmware/src" -I"$json" \
  "$here/host/test_completion_latch_acceptance.cpp" -o "$out/test_completion_latch_acceptance"

"$out/test_completion_latch_acceptance" "$root"

"$cxx" -std=c++17 -O1 -Wall -Wextra -Wno-unused-parameter \
  -I"$firmware/src" \
  "$here/host/test_transcript_disconnect.cpp" -o "$out/test_transcript_disconnect"

"$out/test_transcript_disconnect" "$root"
