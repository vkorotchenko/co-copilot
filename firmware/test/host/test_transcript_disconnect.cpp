// Host regression tests for transcript link transitions and display priority.
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>

#include "completion_latch.h"
#include "transcript_state.h"

static int checks = 0;
static int failures = 0;

static void check(bool ok, const char* expression, int line) {
  checks++;
  if (ok) return;
  failures++;
  std::printf("FAIL line %d: %s\n", line, expression);
}

#define CHECK(expression) check((expression), #expression, __LINE__)

struct TestState {
  char lines[8][160] = {};
  uint8_t nLines = 0;
  uint16_t lineGen = 0;
  TranscriptLinkState link;
  CompletionMirror completion;
};

static void setRows(char (&rows)[8][160], const char* first, const char* second) {
  std::memset(rows, 0, sizeof(rows));
  std::strncpy(rows[0], first, sizeof(rows[0]) - 1);
  std::strncpy(rows[1], second, sizeof(rows[1]) - 1);
}

static void setRow(char (&rows)[8][160], uint8_t index, const char* value) {
  std::strncpy(rows[index], value, sizeof(rows[index]) - 1);
}

static bool rowsWiped(const char (&rows)[8][160]) {
  for (const auto& row : rows) {
    for (char byte : row) if (byte != 0) return false;
  }
  return true;
}

static bool validUtf8(const char* value) {
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(value);
  size_t length = std::strlen(value);
  size_t offset = 0;
  while (offset < length) {
    uint8_t width = sessionUtf8Decode(bytes + offset, length - offset, nullptr);
    if (width == 0) return false;
    offset += width;
  }
  return true;
}

static std::string readFile(const std::string& path) {
  std::ifstream input(path);
  return std::string((std::istreambuf_iterator<char>(input)),
                     std::istreambuf_iterator<char>());
}

static void checkBoundaryClamp(const char* scalar, size_t scalarBytes,
                               size_t asciiPrefix, bool shouldFit) {
  char incoming[192];
  std::memset(incoming, 'a', asciiPrefix);
  std::memcpy(incoming + asciiPrefix, scalar, scalarBytes);
  incoming[asciiPrefix + scalarBytes] = 0;

  char stored[160];
  std::memset(stored, 0xA5, sizeof(stored));
  size_t copied = transcriptCopyRow(stored, incoming);
  const size_t expected = asciiPrefix + (shouldFit ? scalarBytes : 0);
  CHECK(copied == expected);
  CHECK(std::strlen(stored) == expected);
  CHECK(stored[expected] == 0);
  CHECK(validUtf8(stored));
  CHECK(std::memcmp(stored, incoming, asciiPrefix) == 0);
  if (shouldFit) {
    CHECK(std::memcmp(stored + asciiPrefix, scalar, scalarBytes) == 0);
    CHECK(copied == sizeof(stored) - 1);
    CHECK(stored[sizeof(stored) - 1] == 0);
  } else {
    CHECK(copied == asciiPrefix);
    CHECK(stored[asciiPrefix] == 0);
    CHECK(static_cast<unsigned char>(stored[asciiPrefix - 1]) == 'a');
  }
}

static void checkHiddenTranscript(const DisplayOwnershipState& state,
                                  DisplaySurfaceOwner expectedOwner) {
  CHECK(displaySurfaceOwner(state) == expectedOwner);
  CHECK(!transcriptOwnsDisplay(state));
  uint8_t scroll = 4;
  CHECK(!transcriptScroll(transcriptOwnsDisplay(state), scroll, 1, 47));
  CHECK(scroll == 4);
  CHECK(!transcriptClose(transcriptOwnsDisplay(state), scroll));
  CHECK(scroll == 4);
}

int main(int argc, char** argv) {
  TestState state;
  state.completion.reset();
  state.completion.active = true;
  state.completion.epochKnown = true;
  state.completion.epoch = 41;
  state.completion.highestGeneration = 7;
  state.completion.latch.generation = 7;
  std::strcpy(state.completion.latch.summary, "finished");
  CompletionMirror completionBefore = state.completion;

  char oldRows[8][160] = {};
  setRows(oldRows, "13:42 earlier prompt", "13:43 in-flight prompt");
  CHECK(transcriptApplyRows(state.lines, state.nLines, state.lineGen, oldRows, 2));
  CHECK(state.nLines == 2);
  CHECK(state.lineGen == 1);
  CHECK(std::strcmp(state.lines[1], "13:43 in-flight prompt") == 0);

  CHECK(!transcriptObserveConnection(
    state.link, true, state.lines, state.nLines, state.lineGen));
  const uint16_t linkedGeneration = state.lineGen;
  CHECK(transcriptObserveConnection(
    state.link, false, state.lines, state.nLines, state.lineGen));
  CHECK(state.nLines == 0);
  CHECK(rowsWiped(state.lines));
  CHECK(state.lineGen == uint16_t(linkedGeneration + 1));
  CHECK(std::memcmp(&state.completion, &completionBefore, sizeof(completionBefore)) == 0);

  const uint16_t disconnectedGeneration = state.lineGen;
  CHECK(!transcriptObserveConnection(
    state.link, false, state.lines, state.nLines, state.lineGen));
  CHECK(state.lineGen == disconnectedGeneration);

  state.nLines = 2;
  CHECK(activityContentKind(false, state.nLines) == ACTIVITY_DISCONNECTED);
  CHECK(activityContentKind(true, 0) == ACTIVITY_MESSAGE);
  CHECK(activityContentKind(true, state.nLines) == ACTIVITY_TRANSCRIPT);
  CHECK(!activityShowsTranscript(false, state.nLines));
  CHECK(!activityShowsTranscript(true, 0));
  CHECK(activityShowsTranscript(true, state.nLines));

  uint8_t hiddenScroll = 4;
  bool hiddenActionable = activityShowsTranscript(false, state.nLines);
  CHECK(!transcriptScroll(hiddenActionable, hiddenScroll, 1, 47));
  CHECK(hiddenScroll == 4);
  CHECK(!transcriptClose(hiddenActionable, hiddenScroll));
  CHECK(hiddenScroll == 4);

  uint8_t visibleScroll = 1;
  bool visibleActionable = activityShowsTranscript(true, state.nLines);
  CHECK(transcriptScroll(visibleActionable, visibleScroll, 1, 47));
  CHECK(visibleScroll == 2);
  CHECK(transcriptClose(visibleActionable, visibleScroll));
  CHECK(visibleScroll == 0);

  DisplayOwnershipState ownership;
  ownership.screenVisible = true;
  ownership.page = DISPLAY_PAGE_NORMAL;
  ownership.hudEnabled = true;
  ownership.connected = true;
  ownership.transcriptRows = state.nLines;
  CHECK(displaySurfaceOwner(ownership) == DISPLAY_SURFACE_TRANSCRIPT);
  CHECK(transcriptOwnsDisplay(ownership));
  uint8_t ownedScroll = 1;
  CHECK(transcriptScroll(transcriptOwnsDisplay(ownership), ownedScroll, 1, 47));
  CHECK(ownedScroll == 2);
  CHECK(transcriptClose(transcriptOwnsDisplay(ownership), ownedScroll));
  CHECK(ownedScroll == 0);

  DisplayOwnershipState precedence = ownership;
  precedence.uiOverlayVisible = true;
  precedence.passkeyVisible = true;
  precedence.promptVisible = true;
  precedence.clockVisible = true;
  precedence.completionVisible = true;
  precedence.liveCardVisible = true;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_UI_OVERLAY);
  precedence.uiOverlayVisible = false;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_PASSKEY);
  precedence.passkeyVisible = false;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_PROMPT);
  precedence.promptVisible = false;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_CLOCK);
  precedence.clockVisible = false;
  precedence.page = DISPLAY_PAGE_INFO;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_INFO);
  precedence.page = DISPLAY_PAGE_PET;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_PET);
  precedence.page = DISPLAY_PAGE_NORMAL;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_COMPLETION);
  precedence.completionVisible = false;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_LIVE_CARD);
  precedence.liveCardVisible = false;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_TRANSCRIPT);
  precedence.transcriptRows = 0;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_HUD);
  precedence.hudEnabled = false;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_NONE);
  precedence.screenVisible = false;
  precedence.passkeyVisible = true;
  CHECK(displaySurfaceOwner(precedence) == DISPLAY_SURFACE_NONE);

  DisplayOwnershipState hidden = ownership;
  hidden.uiOverlayVisible = true;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_UI_OVERLAY);

  hidden = ownership;
  hidden.clockVisible = true;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_CLOCK);

  hidden = ownership;
  hidden.completionVisible = true;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_COMPLETION);

  hidden = ownership;
  hidden.passkeyVisible = true;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_PASSKEY);

  hidden = ownership;
  hidden.promptVisible = true;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_PROMPT);

  hidden = ownership;
  hidden.page = DISPLAY_PAGE_INFO;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_INFO);

  hidden = ownership;
  hidden.page = DISPLAY_PAGE_PET;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_PET);

  hidden = ownership;
  hidden.hudEnabled = false;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_NONE);

  hidden = ownership;
  hidden.liveCardVisible = true;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_LIVE_CARD);

  hidden = ownership;
  hidden.screenVisible = false;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_NONE);

  hidden = ownership;
  hidden.connected = false;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_HUD);

  hidden = ownership;
  hidden.transcriptRows = 0;
  checkHiddenTranscript(hidden, DISPLAY_SURFACE_HUD);

  DisplayOwnershipState activity = ownership;
  activity.page = DISPLAY_PAGE_ACTIVITY;
  activity.hudEnabled = false;
  CHECK(displaySurfaceOwner(activity) == DISPLAY_SURFACE_TRANSCRIPT);
  CHECK(transcriptOwnsDisplay(activity));
  uint8_t activityScroll = 1;
  CHECK(transcriptScroll(transcriptOwnsDisplay(activity), activityScroll, 1, 47));
  CHECK(activityScroll == 2);
  CHECK(transcriptClose(transcriptOwnsDisplay(activity), activityScroll));
  CHECK(activityScroll == 0);

  // Surfaces that can disappear through input start the frame as non-owners,
  // so the same physical gesture cannot leak through to the revealed transcript.
  for (DisplayOwnershipState modal : {
         [] { DisplayOwnershipState s; s.screenVisible = false; return s; }(),
         [ownership] { DisplayOwnershipState s = ownership; s.completionVisible = true; return s; }(),
         [ownership] { DisplayOwnershipState s = ownership; s.promptVisible = true; return s; }(),
         [ownership] { DisplayOwnershipState s = ownership; s.clockVisible = true; return s; }(),
       }) {
    const bool sampledOwner = transcriptOwnsDisplay(modal);
    modal.screenVisible = true;
    modal.completionVisible = false;
    modal.promptVisible = false;
    modal.clockVisible = false;
    modal.page = DISPLAY_PAGE_NORMAL;
    modal.hudEnabled = true;
    modal.connected = true;
    modal.transcriptRows = 2;
    CHECK(transcriptOwnsDisplay(modal));
    uint8_t seamScroll = 4;
    CHECK(!transcriptScroll(sampledOwner, seamScroll, 1, 47));
    CHECK(seamScroll == 4);
    CHECK(!transcriptClose(sampledOwner, seamScroll));
    CHECK(seamScroll == 4);
  }
  state.nLines = 0;

  // A scalar that crosses the 159-byte payload limit is omitted whole.
  checkBoundaryClamp("\xC3\xA9", 2, 158, false);       // U+00E9
  checkBoundaryClamp("\xE2\x82\xAC", 3, 158, false);   // U+20AC
  checkBoundaryClamp("\xF0\x9F\x98\x80", 4, 158, false); // U+1F600

  // A scalar ending exactly at byte 159 is retained whole.
  checkBoundaryClamp("\xC3\xA9", 2, 157, true);        // U+00E9
  checkBoundaryClamp("\xE2\x82\xAC", 3, 156, true);    // U+20AC
  checkBoundaryClamp("\xF0\x9F\x98\x80", 4, 155, true); // U+1F600

  char nullStored[160];
  std::memset(nullStored, 0xA5, sizeof(nullStored));
  CHECK(transcriptCopyRow(nullStored, nullptr) == 0);
  CHECK(nullStored[0] == 0);

  // ArduinoJson maps malformed non-string entries to null. The intentional
  // firmware policy is to retain their array position as an empty row.
  char parsedRows[2][160] = {};
  uint8_t parsedCount = 0;
  CHECK(transcriptAppendParsedRow(parsedRows, parsedCount, nullptr));
  CHECK(parsedCount == 1);
  CHECK(parsedRows[0][0] == 0);
  CHECK(transcriptAppendParsedRow(parsedRows, parsedCount, "15:01 newest"));
  CHECK(parsedCount == 2);
  CHECK(std::strcmp(parsedRows[1], "15:01 newest") == 0);
  CHECK(!transcriptAppendParsedRow(parsedRows, parsedCount, "overflow"));
  CHECK(parsedCount == 2);

  CHECK(transcriptRowIsCurrent(2, 3, 0));
  CHECK(!transcriptRowIsCurrent(1, 3, 0));
  CHECK(!transcriptRowIsCurrent(2, 3, 1));
  CHECK(!transcriptRowIsCurrent(0, 0, 0));

  // Same-frame regression: a click returns from a secondary transcript screen
  // before the simultaneously observed touch-close is handled.
  DisplayOwnershipState postClick = ownership;
  CHECK(transcriptOwnsDisplay(postClick));
  uint8_t sameFrameScroll = 4;
  postClick.page = DISPLAY_PAGE_PET;
  CHECK(!transcriptClose(transcriptOwnsDisplay(postClick), sameFrameScroll));
  CHECK(sameFrameScroll == 4);

  // The original euro repro must never leave the first byte of a split scalar.
  char euroIncoming[162];
  std::memset(euroIncoming, 'a', 158);
  std::memcpy(euroIncoming + 158, "\xE2\x82\xAC", 3);
  euroIncoming[161] = 0;
  char euroStored[160];
  transcriptCopyRow(euroStored, euroIncoming);
  CHECK(std::strlen(euroStored) == 158);
  CHECK(euroStored[158] == 0);
  CHECK(static_cast<unsigned char>(euroStored[158]) != 0xE2);
  CHECK(validUtf8(euroStored));

  CHECK(argc == 2);
  if (argc == 2) {
    const std::string root = argv[1];
    const std::string mainSource = readFile(root + "/firmware/src/main.cpp");
    const std::string dataSource = readFile(root + "/firmware/src/data.h");
    CHECK(!mainSource.empty());
    CHECK(mainSource.find("bool transcriptOwned = transcriptOwnsDisplay(inputOwnership)") !=
          std::string::npos);
    CHECK(mainSource.find("transcriptScroll(transcriptOwned, msgScroll, enc") !=
          std::string::npos);
    CHECK(mainSource.find("transcriptClose(transcriptOwned, msgScroll)") !=
          std::string::npos);
    CHECK(mainSource.find(
      "transcriptRowIsCurrent(srcOf[row], tama.nLines, msgScroll)") !=
      std::string::npos);
    CHECK(mainSource.find(
      "state.uiOverlayVisible = menuOpen || settingsOpen || resetOpen") !=
      std::string::npos);
    CHECK(dataSource.find(
      "transcriptAppendParsedRow(nextLines, n, v.as<const char*>())") !=
      std::string::npos);
    CHECK(mainSource.find("DisplaySurfaceOwner displayOwner = displaySurfaceOwner(renderOwnership)") !=
          std::string::npos);
    CHECK(mainSource.find("switch (displayOwner)") != std::string::npos);

    const size_t poll = mainSource.find("dataPoll(&tama)");
    const size_t inputOwner = mainSource.find(
      "DisplayOwnershipState inputOwnership = currentDisplayOwnership(");
    const size_t inputRead = mainSource.find("int enc = readEncoder(");
    const size_t pageChange = mainSource.find("displayMode = DISP_NORMAL;", inputRead);
    const size_t refreshedOwner = mainSource.find(
      "inputOwnership = currentDisplayOwnership(", pageChange);
    const size_t close = mainSource.find(
      "transcriptClose(transcriptOwned, msgScroll)");
    const size_t renderOwner = mainSource.find(
      "DisplayOwnershipState renderOwnership = currentDisplayOwnership(");
    CHECK(poll < inputOwner);
    CHECK(inputOwner < inputRead);
    CHECK(inputRead < pageChange);
    CHECK(pageChange < refreshedOwner);
    CHECK(refreshedOwner < close);
    CHECK(close < renderOwner);
  }

  CHECK(!transcriptObserveConnection(
    state.link, true, state.lines, state.nLines, state.lineGen));
  char newRows[8][160] = {};
  setRows(newRows, "13:44 restored history", "13:45 new live prompt");
  CHECK(transcriptApplyRows(state.lines, state.nLines, state.lineGen, newRows, 2));
  CHECK(state.lineGen == uint16_t(disconnectedGeneration + 1));
  CHECK(state.nLines == 2);
  CHECK(std::strcmp(state.lines[0], "13:44 restored history") == 0);
  CHECK(std::strcmp(state.lines[1], "13:45 new live prompt") == 0);

  const uint16_t snapshotGeneration = state.lineGen;
  CHECK(!transcriptApplyRows(state.lines, state.nLines, state.lineGen, newRows, 2));
  CHECK(state.lineGen == snapshotGeneration);
  std::strcpy(newRows[1], "13:45 live prompt updated");
  CHECK(transcriptApplyRows(state.lines, state.nLines, state.lineGen, newRows, 2));
  CHECK(state.lineGen == uint16_t(snapshotGeneration + 1));
  CHECK(std::strcmp(state.lines[1], "13:45 live prompt updated") == 0);

    // Replacing a longer snapshot must wipe every byte beyond the new count.
  char longRows[8][160] = {};
  for (uint8_t i = 0; i < 8; i++) {
    char value[32];
    std::snprintf(value, sizeof(value), "14:%02u private row", i);
    setRow(longRows, i, value);
  }
  CHECK(transcriptApplyRows(state.lines, state.nLines, state.lineGen, longRows, 8));
  char shortRows[8][160] = {};
  setRow(shortRows, 0, "14:10 retained one");
  setRow(shortRows, 1, "14:11 retained two");
  setRow(shortRows, 2, "14:12 retained newest");
  const uint16_t beforeShrink = state.lineGen;
  CHECK(transcriptApplyRows(state.lines, state.nLines, state.lineGen, shortRows, 3));
  CHECK(state.lineGen == uint16_t(beforeShrink + 1));
  CHECK(state.nLines == 3);
  CHECK(std::strcmp(state.lines[2], "14:12 retained newest") == 0);
  bool tailWiped = true;
  for (uint8_t i = 3; i < 8; i++) {
    for (char byte : state.lines[i]) if (byte != 0) tailWiped = false;
  }
  CHECK(tailWiped);

  // An explicit empty snapshot clears rows once; repeating it is idempotent.
  char emptyRows[8][160] = {};
  const uint16_t beforeClear = state.lineGen;
  CHECK(transcriptApplyRows(state.lines, state.nLines, state.lineGen, emptyRows, 0));
  CHECK(state.nLines == 0);
  CHECK(rowsWiped(state.lines));
  CHECK(state.lineGen == uint16_t(beforeClear + 1));
  CHECK(!transcriptApplyRows(state.lines, state.nLines, state.lineGen, emptyRows, 0));
  CHECK(state.lineGen == uint16_t(beforeClear + 1));

  // Reconnect alone must not restore stale rows before a fresh snapshot lands.
  setRows(oldRows, "14:20 old history", "14:21 old newest");
  CHECK(transcriptApplyRows(state.lines, state.nLines, state.lineGen, oldRows, 2));
  CHECK(!transcriptObserveConnection(
    state.link, true, state.lines, state.nLines, state.lineGen));
  CHECK(transcriptObserveConnection(
    state.link, false, state.lines, state.nLines, state.lineGen));
  const uint16_t beforeReconnect = state.lineGen;
  CHECK(!transcriptObserveConnection(
    state.link, true, state.lines, state.nLines, state.lineGen));
  CHECK(state.nLines == 0);
  CHECK(rowsWiped(state.lines));
  CHECK(state.lineGen == beforeReconnect);
  CHECK(activityContentKind(true, state.nLines) == ACTIVITY_MESSAGE);

  // A rapid down-up-down flap must re-arm and clear exactly once per down edge.
  setRows(newRows, "14:30 new history", "14:31 new newest");
  CHECK(transcriptApplyRows(state.lines, state.nLines, state.lineGen, newRows, 2));
  const uint16_t beforeSecondDown = state.lineGen;
  CHECK(transcriptObserveConnection(
    state.link, false, state.lines, state.nLines, state.lineGen));
  CHECK(state.lineGen == uint16_t(beforeSecondDown + 1));
  CHECK(rowsWiped(state.lines));
  CHECK(!transcriptObserveConnection(
    state.link, false, state.lines, state.nLines, state.lineGen));
  CHECK(state.lineGen == uint16_t(beforeSecondDown + 1));

  // Generation wrap must still clear bytes and leave repeated stale ticks inert.
  setRows(oldRows, "14:40 wrap history", "14:41 wrap newest");
  state.lineGen = UINT16_MAX;
  CHECK(!transcriptObserveConnection(
    state.link, true, state.lines, state.nLines, state.lineGen));
  CHECK(transcriptApplyRows(state.lines, state.nLines, state.lineGen, oldRows, 2));
  CHECK(state.lineGen == 0);
  CHECK(transcriptObserveConnection(
    state.link, false, state.lines, state.nLines, state.lineGen));
  CHECK(state.lineGen == 1);
  CHECK(state.nLines == 0);
  CHECK(rowsWiped(state.lines));
  CHECK(!transcriptObserveConnection(
    state.link, false, state.lines, state.nLines, state.lineGen));
  CHECK(state.lineGen == 1);

  std::printf("transcript disconnect: %d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
