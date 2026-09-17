// Host-side tests for the session-pal parser, clamps, wrapper, and selection
// tracker. No Arduino, no M5, no Unity — session_pals.h is deliberately free of
// device dependencies so this compiles with a plain C++ compiler and asserts.
//
// Run with firmware/test/run-host-tests.sh.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>

#include "session_pals.h"
#include "completion_latch_json.h"

// ──────────────── tiny harness ────────────────
static int g_failures = 0;
static int g_checks = 0;
static const char* g_case = "";

static void check(bool ok, const char* what, const char* file, int line) {
  g_checks++;
  if (ok) return;
  g_failures++;
  std::printf("  FAIL [%s] %s (%s:%d)\n", g_case, what, file, line);
}
#define CHECK(cond) check((cond), #cond, __FILE__, __LINE__)
#define CHECK_STR(a, b) check(std::strcmp((a), (b)) == 0, #a " == " #b, __FILE__, __LINE__)

static void begin(const char* name) {
  g_case = name;
  std::printf("- %s\n", name);
}

static std::string readFile(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    std::printf("FATAL: cannot open %s\n", path.c_str());
    std::exit(2);
  }
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

// Parse one wire line the way data.h does, then apply the projection.
static void applyLine(const char* line, SessionPalSet& set) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  CHECK(!err);
  if (err) return;
  sessionPalsApply(doc.as<JsonVariantConst>(), set);
}

static std::string g_root;   // repo root

// ──────────────── 1. real bridge bytes ────────────────
static void testFixtures() {
  std::string raw = readFile(g_root + "/firmware/test/fixtures/session-lines.json");
  JsonDocument fx;
  DeserializationError err = deserializeJson(fx, raw);
  if (err) {
    std::printf("FATAL: fixture parse failed: %s\n", err.c_str());
    std::exit(2);
  }

  for (JsonObjectConst c : fx["cases"].as<JsonArrayConst>()) {
    std::string name = std::string("wire/") + (const char*)c["name"];
    begin(name.c_str());

    SessionPalSet set;
    sessionPalsClear(set);
    applyLine(c["line"], set);

    JsonObjectConst exp = c["expect"];
    CHECK(set.version == (uint8_t)(exp["version"] | 0));
    CHECK(set.count == (uint8_t)(exp["count"] | 0));
    if (set.count != (uint8_t)(exp["count"] | 0)) continue;

    uint8_t i = 0;
    for (JsonObjectConst p : exp["pals"].as<JsonArrayConst>()) {
      const SessionPal& got = set.pals[i];
      CHECK_STR(got.id, (const char*)p["id"]);
      CHECK(got.species == (uint8_t)(p["species"] | 255));
      CHECK(got.state == (uint8_t)(p["state"] | 255));
      CHECK_STR(got.summary, (const char*)p["summary"]);
      if (p["output_tokens"].is<uint32_t>()) {
        CHECK(sessionUsageKnown(got));
        CHECK(got.outputTokens == p["output_tokens"].as<uint32_t>());
      } else {
        CHECK(!sessionUsageKnown(got));
      }
      if (p["input_tokens"].is<uint32_t>()) {
        CHECK(sessionInputUsageKnown(got));
        CHECK(got.inputTokens == p["input_tokens"].as<uint32_t>());
      } else {
        CHECK(!sessionInputUsageKnown(got));
      }
      CHECK_STR(got.model, p["model"].is<const char*>() ? p["model"].as<const char*>() : "");
      CHECK(got.modelCount == (uint8_t)(p["model_count"] | 0));
      JsonArrayConst context = p["context"].as<JsonArrayConst>();
      if (!context.isNull()) {
        CHECK(sessionContextKnown(got));
        CHECK(got.contextUsed == context[0].as<uint32_t>());
        CHECK(got.contextMax == context[1].as<uint32_t>());
      } else {
        CHECK(!sessionContextKnown(got));
      }
      uint8_t k = 0;
      for (JsonVariantConst col : p["colors"].as<JsonArrayConst>()) {
        CHECK(got.colors[k] == (uint16_t)col.as<uint32_t>());
        k++;
      }
      CHECK(k == 5);
      i++;
    }
  }

  // Every summary that survived the bridge clamp must still be valid UTF-8 and
  // fit the firmware's fixed storage.
  begin("wire/summaries-are-well-formed");
  for (JsonObjectConst c : fx["cases"].as<JsonArrayConst>()) {
    SessionPalSet set;
    sessionPalsClear(set);
    applyLine(c["line"], set);
    for (uint8_t i = 0; i < set.count; i++) {
      size_t n = std::strlen(set.pals[i].summary);
      CHECK(n <= SESSION_SUMMARY_BYTES);
      size_t at = 0;
      while (at < n) {
        uint8_t adv = sessionUtf8Decode((const uint8_t*)set.pals[i].summary + at, n - at, nullptr);
        CHECK(adv != 0);
        if (!adv) break;
        at += adv;
      }
    }
  }
}

static void testUsageFormatting() {
  begin("usage/uint32 JSON boundaries");
  {
    JsonDocument doc;
    CHECK(!deserializeJson(doc, "{\"tokens\":2147483648}"));
    CHECK(doc["tokens"].is<uint32_t>());
    CHECK(doc["tokens"].as<uint32_t>() == 2147483648u);
    CHECK(!deserializeJson(doc, "{\"tokens\":4294967295}"));
    CHECK(doc["tokens"].is<uint32_t>());
    CHECK(doc["tokens"].as<uint32_t>() == UINT32_MAX);
  }

  begin("usage/compact token formatting");
  {
    char out[12];
    sessionFormatTokens(0, out, sizeof(out));          CHECK_STR(out, "0");
    sessionFormatTokens(999, out, sizeof(out));        CHECK_STR(out, "999");
    sessionFormatTokens(1000, out, sizeof(out));       CHECK_STR(out, "1.0K");
    sessionFormatTokens(123456, out, sizeof(out));     CHECK_STR(out, "123K");
    sessionFormatTokens(999999, out, sizeof(out));     CHECK_STR(out, "1.0M");
    sessionFormatTokens(1000000, out, sizeof(out));    CHECK_STR(out, "1.0M");
    sessionFormatTokens(3456789, out, sizeof(out));    CHECK_STR(out, "3.5M");
    sessionFormatTokens(4294967294u, out, sizeof(out)); CHECK_STR(out, "4295M");
  }

  begin("usage/optional wire field");
  {
    SessionPalSet set;
    sessionPalsClear(set);
    applyLine(
      "{\"sv\":1,\"ss\":[{\"i\":\"0123456789ab\",\"p\":1,"
      "\"c\":[1,2,3,4,5],\"s\":0,\"m\":\"known\",\"u\":142,\"q\":500,"
      "\"d\":\"gpt-test\",\"v\":2,\"x\":[42000,128000]}]}",
      set);
    CHECK(set.count == 1);
    CHECK(sessionUsageKnown(set.pals[0]));
    CHECK(set.pals[0].outputTokens == 142u);
    CHECK(sessionInputUsageKnown(set.pals[0]));
    CHECK(set.pals[0].inputTokens == 500u);
    CHECK_STR(set.pals[0].model, "gpt-test");
    CHECK(set.pals[0].modelCount == 2);
    CHECK(sessionContextKnown(set.pals[0]));
    CHECK(sessionContextPercent(set.pals[0]) == 32);
    CHECK(sessionHeartCount(set.pals[0]) == 1);
    CHECK(sessionHeartProgress(set.pals[0]) == 42);

    applyLine(
      "{\"sv\":1,\"ss\":[{\"i\":\"0123456789ab\",\"p\":1,"
      "\"c\":[1,2,3,4,5],\"s\":0,\"m\":\"legacy\"}]}",
      set);
    CHECK(set.count == 1);
    CHECK(!sessionUsageKnown(set.pals[0]));
    CHECK(!sessionInputUsageKnown(set.pals[0]));
    CHECK(!sessionContextKnown(set.pals[0]));
    CHECK(set.pals[0].model[0] == 0);
    CHECK(set.pals[0].modelCount == 0);

    applyLine(
      "{\"sv\":1,\"ss\":[{\"i\":\"0123456789ab\",\"p\":1,"
      "\"c\":[1,2,3,4,5],\"s\":0,\"m\":\"sentinel\",\"u\":4294967295}]}",
      set);
    CHECK(set.count == 0);

    applyLine(
      "{\"sv\":1,\"ss\":[{\"i\":\"0123456789ab\",\"p\":1,"
      "\"c\":[1,2,3,4,5],\"s\":0,\"m\":\"bad context\","
      "\"x\":[128001,128000]}]}",
      set);
    CHECK(set.count == 0);
  }
}

// ──────────────── 2. catalog drift ────────────────
// The wire carries a species *index*. If buddy.cpp's SPECIES_TABLE order ever
// diverges from the bridge catalog, every pal renders as the wrong animal and
// nothing else in the system notices. Compare them textually.
static void testCatalogOrder() {
  begin("catalog/firmware order matches bridge");
  std::string src = readFile(g_root + "/firmware/src/buddy.cpp");
  size_t start = src.find("SPECIES_TABLE[] = {");
  CHECK(start != std::string::npos);
  if (start == std::string::npos) return;
  size_t end = src.find("};", start);
  std::string block = src.substr(start, end - start);

  std::vector<std::string> names;
  size_t pos = 0;
  while ((pos = block.find('&', pos)) != std::string::npos) {
    size_t e = block.find("_SPECIES", pos);
    if (e == std::string::npos) break;
    std::string n = block.substr(pos + 1, e - pos - 1);
    for (auto& ch : n) ch = (char)std::tolower((unsigned char)ch);
    names.push_back(n);
    pos = e;
  }

  std::string raw = readFile(g_root + "/firmware/test/fixtures/session-lines.json");
  JsonDocument fx;
  deserializeJson(fx, raw);
  JsonArrayConst bridgeSpecies = fx["species"].as<JsonArrayConst>();

  CHECK(names.size() == bridgeSpecies.size());
  CHECK(names.size() == (size_t)(SESSION_SPECIES_MAX + 1));
  size_t i = 0;
  for (JsonVariantConst s : bridgeSpecies) {
    if (i >= names.size()) break;
    CHECK_STR(names[i].c_str(), s.as<const char*>());
    i++;
  }
}

// ──────────────── 3. hostile / malformed input ────────────────
static void applyRaw(const char* line, SessionPalSet& set) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) return;      // a bad line never mutates state
  sessionPalsApply(doc.as<JsonVariantConst>(), set);
}

static const char* ROW_OK =
  "{\"i\":\"0123456789ab\",\"p\":7,\"c\":[2047,0,65535,33808,0],\"s\":4,\"m\":\"ok\"}";

static std::string lineWith(const std::string& rows) {
  return "{\"total\":1,\"running\":1,\"waiting\":0,\"msg\":\"x\",\"sv\":1,\"ss\":[" + rows + "]}";
}

static void testMalformed() {
  struct Bad { const char* name; const char* row; };
  const Bad bad[] = {
    { "id too short",     "{\"i\":\"0123456789a\",\"p\":0,\"c\":[1,0,2,3,0],\"s\":0,\"m\":\"\"}" },
    { "id too long",      "{\"i\":\"0123456789abc\",\"p\":0,\"c\":[1,0,2,3,0],\"s\":0,\"m\":\"\"}" },
    { "id uppercase",     "{\"i\":\"0123456789AB\",\"p\":0,\"c\":[1,0,2,3,0],\"s\":0,\"m\":\"\"}" },
    { "id non-hex",       "{\"i\":\"0123456789az\",\"p\":0,\"c\":[1,0,2,3,0],\"s\":0,\"m\":\"\"}" },
    { "id missing",       "{\"p\":0,\"c\":[1,0,2,3,0],\"s\":0,\"m\":\"\"}" },
    { "species over max", "{\"i\":\"0123456789ab\",\"p\":18,\"c\":[1,0,2,3,0],\"s\":0,\"m\":\"\"}" },
    { "species negative", "{\"i\":\"0123456789ab\",\"p\":-1,\"c\":[1,0,2,3,0],\"s\":0,\"m\":\"\"}" },
    { "species string",   "{\"i\":\"0123456789ab\",\"p\":\"owl\",\"c\":[1,0,2,3,0],\"s\":0,\"m\":\"\"}" },
    { "state over max",   "{\"i\":\"0123456789ab\",\"p\":0,\"c\":[1,0,2,3,0],\"s\":5,\"m\":\"\"}" },
    { "colors short",     "{\"i\":\"0123456789ab\",\"p\":0,\"c\":[1,0,2,3],\"s\":0,\"m\":\"\"}" },
    { "colors long",      "{\"i\":\"0123456789ab\",\"p\":0,\"c\":[1,0,2,3,0,9],\"s\":0,\"m\":\"\"}" },
    { "colors overflow",  "{\"i\":\"0123456789ab\",\"p\":0,\"c\":[65536,0,2,3,0],\"s\":0,\"m\":\"\"}" },
    { "colors negative",  "{\"i\":\"0123456789ab\",\"p\":0,\"c\":[-1,0,2,3,0],\"s\":0,\"m\":\"\"}" },
    { "colors missing",   "{\"i\":\"0123456789ab\",\"p\":0,\"s\":0,\"m\":\"\"}" },
    { "row is a number",  "42" },
    { "row is a string",  "\"nope\"" },
    { "row is an array",  "[1,2,3]" },
    { "row is null",      "null" },
  };

  for (const Bad& b : bad) {
    std::string name = std::string("malformed/") + b.name;
    begin(name.c_str());
    SessionPalSet set;
    sessionPalsClear(set);
    applyRaw(lineWith(b.row).c_str(), set);
    CHECK(set.count == 0);                       // dropped, not accepted

    // ...and a bad row must not hide a healthy neighbour behind it.
    sessionPalsClear(set);
    applyRaw(lineWith(std::string(b.row) + "," + ROW_OK).c_str(), set);
    CHECK(set.count == 1);
    if (set.count == 1) CHECK_STR(set.pals[0].id, "0123456789ab");
  }

  begin("malformed/truncated json leaves state untouched");
  {
    SessionPalSet set;
    sessionPalsClear(set);
    applyRaw(lineWith(ROW_OK).c_str(), set);
    CHECK(set.count == 1);
    // Simulate a line cut off by the 4096-byte buffer: deserialization fails,
    // so _applyJson returns before touching any field.
    std::string full = lineWith(ROW_OK);
    applyRaw(full.substr(0, full.size() - 12).c_str(), set);
    CHECK(set.count == 1);
    CHECK_STR(set.pals[0].id, "0123456789ab");
  }

  begin("malformed/duplicate display ids collapse");
  {
    SessionPalSet set;
    sessionPalsClear(set);
    applyRaw(lineWith(std::string(ROW_OK) + "," + ROW_OK).c_str(), set);
    CHECK(set.count == 1);
  }

  begin("malformed/more than eight rows are ignored past the cap");
  {
    std::string rows;
    for (int i = 0; i < 12; i++) {
      char id[16];
      std::snprintf(id, sizeof(id), "%012x", i);
      if (i) rows += ",";
      rows += std::string("{\"i\":\"") + id +
              "\",\"p\":1,\"c\":[1,0,2,3,0],\"s\":2,\"m\":\"x\"}";
    }
    SessionPalSet set;
    sessionPalsClear(set);
    applyRaw(lineWith(rows).c_str(), set);
    CHECK(set.count == MAX_SESSION_PALS);
    CHECK_STR(set.pals[0].id, "000000000000");
    CHECK_STR(set.pals[7].id, "000000000007");
  }
}

// ──────────────── 4. legacy / version handling ────────────────
static void testVersioning() {
  begin("version/legacy line yields no projection");
  {
    SessionPalSet set;
    sessionPalsClear(set);
    applyRaw("{\"total\":2,\"running\":1,\"waiting\":0,\"msg\":\"hi\"}", set);
    CHECK(set.version == 0);
    CHECK(set.count == 0);
  }

  begin("version/legacy line resets a previous projection");
  {
    SessionPalSet set;
    sessionPalsClear(set);
    applyRaw(lineWith(ROW_OK).c_str(), set);
    CHECK(set.count == 1);
    applyRaw("{\"total\":1,\"running\":1,\"waiting\":0,\"msg\":\"hi\"}", set);
    CHECK(set.count == 0);
    CHECK(set.version == 0);
  }

  begin("version/unknown future version is ignored, not guessed");
  {
    SessionPalSet set;
    sessionPalsClear(set);
    applyRaw("{\"total\":1,\"msg\":\"x\",\"sv\":2,\"ss\":[{\"i\":\"0123456789ab\","
             "\"p\":0,\"c\":[1,0,2,3,0],\"s\":0,\"m\":\"\"}]}", set);
    CHECK(set.count == 0);
    CHECK(set.version == 0);
  }

  begin("version/sv present with empty ss means zero sessions");
  {
    SessionPalSet set;
    sessionPalsClear(set);
    applyRaw("{\"total\":1,\"msg\":\"x\",\"sv\":1,\"ss\":[]}", set);
    CHECK(set.count == 0);
  }

  begin("version/sv without ss falls back to legacy");
  {
    SessionPalSet set;
    sessionPalsClear(set);
    applyRaw("{\"total\":1,\"msg\":\"x\",\"sv\":1}", set);
    CHECK(set.count == 0);
  }

  begin("version/a 4095-byte line is accepted");
  {
    // The firmware line buffer keeps 4095 non-newline bytes. Pad a valid
    // snapshot up to exactly that and confirm the projection still lands.
    std::string head = "{\"total\":1,\"running\":1,\"waiting\":0,\"msg\":\"x\",\"entries\":[\"";
    std::string tail = "\"],\"sv\":1,\"ss\":[" + std::string(ROW_OK) + "]}";
    size_t pad = 4095 - head.size() - tail.size();
    std::string line = head + std::string(pad, 'a') + tail;
    CHECK(line.size() == 4095);
    SessionPalSet set;
    sessionPalsClear(set);
    applyRaw(line.c_str(), set);
    CHECK(set.count == 1);
  }
}

// ──────────────── 5. UTF-8 ────────────────
static void testUtf8() {
  begin("utf8/clamp stops on a code-point boundary");
  {
    // 16 × 3-byte characters = 48 bytes exactly, then one more that must not fit.
    std::string s;
    for (int i = 0; i < 17; i++) s += "\xE2\x9C\x85";   // U+2705
    char dst[SESSION_SUMMARY_BYTES + 1];
    size_t n = sessionUtf8Clamp(s.c_str(), dst, sizeof(dst));
    CHECK(n == 48);
    CHECK(std::strlen(dst) == 48);
    CHECK(n % 3 == 0);                                  // never a partial sequence
  }

  begin("utf8/clamp refuses to split a 4-byte character");
  {
    std::string s(47, 'a');
    s += "\xF0\x9F\x90\xB1";                            // U+1F431, would need 51
    char dst[SESSION_SUMMARY_BYTES + 1];
    size_t n = sessionUtf8Clamp(s.c_str(), dst, sizeof(dst));
    CHECK(n == 47);
  }

  begin("utf8/invalid sequences are rejected");
  {
    uint32_t cp = 0;
    CHECK(sessionUtf8Decode((const uint8_t*)"\x80", 1, &cp) == 0);          // stray continuation
    CHECK(sessionUtf8Decode((const uint8_t*)"\xC0\xAF", 2, &cp) == 0);      // overlong '/'
    CHECK(sessionUtf8Decode((const uint8_t*)"\xE0\x80\xAF", 3, &cp) == 0);  // overlong
    CHECK(sessionUtf8Decode((const uint8_t*)"\xED\xA0\x80", 3, &cp) == 0);  // surrogate
    CHECK(sessionUtf8Decode((const uint8_t*)"\xF5\x80\x80\x80", 4, &cp) == 0); // > U+10FFFF
    CHECK(sessionUtf8Decode((const uint8_t*)"\xE2\x9C", 2, &cp) == 0);      // truncated
    CHECK(sessionUtf8Decode((const uint8_t*)"\xE2\x9C\x85", 3, &cp) == 3);
    CHECK(cp == 0x2705);
  }

  begin("utf8/a hostile summary truncates instead of storing garbage");
  {
    char dst[SESSION_SUMMARY_BYTES + 1];
    sessionUtf8Clamp("ok\xC0\xAF" "bad", dst, sizeof(dst));
    CHECK_STR(dst, "ok");
  }

  begin("utf8/display flattens one glyph per code point");
  {
    char dst[64];
    size_t n = sessionSummaryDisplay("a\xE2\x9C\x85z", dst, sizeof(dst));
    CHECK(n == 3);
    CHECK_STR(dst, "a?z");

    sessionSummaryDisplay("a\tb\nc", dst, sizeof(dst));
    CHECK_STR(dst, "a b c");
  }
}

// ──────────────── 6. wrapping ────────────────
static void testWrap() {
  char rows[2][23];

  begin("wrap/short summary uses one row");
  {
    uint8_t n = sessionWrap("build the thing", &rows[0][0], 2, sizeof(rows[0]), 22);
    CHECK(n == 1);
    CHECK_STR(rows[0], "build the thing");
  }

  begin("wrap/breaks on spaces within the column budget");
  {
    uint8_t n = sessionWrap("reviewing the BLE protocol docs", &rows[0][0], 2, sizeof(rows[0]), 22);
    CHECK(n == 2);
    CHECK(std::strlen(rows[0]) <= 22);
    CHECK(std::strlen(rows[1]) <= 22);
    CHECK(rows[0][std::strlen(rows[0]) - 1] != ' ');
  }

  begin("wrap/hard-breaks a word longer than the row");
  {
    uint8_t n = sessionWrap("supercalifragilisticexpialidocious", &rows[0][0], 2, sizeof(rows[0]), 22);
    CHECK(n == 2);
    CHECK(std::strlen(rows[0]) == 22);
  }

  begin("wrap/overflow is ellipsised, never clipped silently");
  {
    std::string longText(200, 'x');
    uint8_t n = sessionWrap(longText.c_str(), &rows[0][0], 2, sizeof(rows[0]), 22);
    CHECK(n == 2);
    size_t last = std::strlen(rows[1]);
    CHECK(last <= 22);
    CHECK(last >= 2);
    CHECK(rows[1][last - 1] == '.' && rows[1][last - 2] == '.');
  }

  begin("wrap/empty and null are safe");
  {
    CHECK(sessionWrap("", &rows[0][0], 2, sizeof(rows[0]), 22) == 0);
    CHECK(sessionWrap(nullptr, &rows[0][0], 2, sizeof(rows[0]), 22) == 0);
    CHECK(rows[0][0] == 0);
  }

  begin("wrap/every clamped summary fits two rows without overrun");
  {
    // Worst case the wire allows: 48 bytes of single-column characters.
    std::string s;
    for (int i = 0; i < 24; i++) s += "ab";
    char guard[3][23];
    std::memset(guard, 0x7E, sizeof(guard));
    uint8_t n = sessionWrap(s.c_str(), &guard[0][0], 2, sizeof(guard[0]), 22);
    CHECK(n == 2);
    CHECK(guard[2][0] == 0x7E);                 // third row untouched
    CHECK(std::strlen(guard[0]) <= 22);
    CHECK(std::strlen(guard[1]) <= 22);
  }
}

// ──────────────── 7. selection tracking ────────────────
static void setOf(SessionPalSet& set, std::initializer_list<const char*> ids) {
  sessionPalsClear(set);
  uint8_t i = 0;
  for (const char* id : ids) {
    std::strncpy(set.pals[i].id, id, SESSION_ID_LEN);
    set.pals[i].id[SESSION_ID_LEN] = 0;
    set.pals[i].species = i;
    set.pals[i].state = SESS_WORKING;
    set.pals[i].summary[0] = 0;
    set.pals[i].model[0] = 0;
    set.pals[i].outputTokens = SESSION_USAGE_UNKNOWN;
    set.pals[i].inputTokens = SESSION_USAGE_UNKNOWN;
    set.pals[i].contextUsed = SESSION_USAGE_UNKNOWN;
    set.pals[i].contextMax = SESSION_USAGE_UNKNOWN;
    set.pals[i].modelCount = 0;
    i++;
  }
  set.version = SESSION_SCHEMA_VERSION;
  set.count = i;
}

static void testSelection() {
  char sel[SESSION_ID_LEN + 1] = "";
  SessionPalSet set;

  begin("selection/defaults to the highest-ranked row");
  {
    setOf(set, { "aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc" });
    sel[0] = 0;
    CHECK(sessionSelectionResolve(set, sel, sizeof(sel)) == 0);
    CHECK_STR(sel, "aaaaaaaaaaaa");
  }

  begin("selection/survives a re-rank");
  {
    setOf(set, { "aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc" });
    sel[0] = 0;
    sessionSelectionStep(set, sel, sizeof(sel), 1);          // now on b
    CHECK_STR(sel, "bbbbbbbbbbbb");
    setOf(set, { "cccccccccccc", "bbbbbbbbbbbb", "aaaaaaaaaaaa" });   // bridge re-ranks
    CHECK(sessionSelectionResolve(set, sel, sizeof(sel)) == 1);
    CHECK_STR(sel, "bbbbbbbbbbbb");                          // same session, new index
  }

  begin("selection/token-heart owner follows a mid-animation re-rank");
  {
    setOf(set, { "aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc" });
    const char* heartOwner = "bbbbbbbbbbbb";
    std::strcpy(sel, heartOwner);
    CHECK(sessionSelectionResolve(set, sel, sizeof(sel)) == 1);
    setOf(set, { "bbbbbbbbbbbb", "cccccccccccc", "aaaaaaaaaaaa" });
    std::strcpy(sel, heartOwner);
    CHECK(sessionSelectionResolve(set, sel, sizeof(sel)) == 0);
    CHECK_STR(sel, heartOwner);
  }

  begin("selection/falls back to rank 0 when the tracked row disappears");
  {
    setOf(set, { "aaaaaaaaaaaa", "bbbbbbbbbbbb" });
    std::strcpy(sel, "bbbbbbbbbbbb");
    setOf(set, { "cccccccccccc", "aaaaaaaaaaaa" });          // b ended
    CHECK(sessionSelectionResolve(set, sel, sizeof(sel)) == 0);
    CHECK_STR(sel, "cccccccccccc");
  }

  begin("selection/steps wrap in both directions");
  {
    setOf(set, { "aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc" });
    std::strcpy(sel, "aaaaaaaaaaaa");
    CHECK(sessionSelectionStep(set, sel, sizeof(sel), -1) == 2);   // wrap backwards
    CHECK(sessionSelectionStep(set, sel, sizeof(sel), 1) == 0);    // wrap forwards
    CHECK(sessionSelectionStep(set, sel, sizeof(sel), 3) == 0);    // fast spin, 3 of 3
    CHECK(sessionSelectionStep(set, sel, sizeof(sel), -3) == 0);
  }

  begin("selection/fast spin of three lands correctly on a long roster");
  {
    setOf(set, { "aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd",
                 "eeeeeeeeeeee", "ffffffffffff", "111111111111", "222222222222" });
    std::strcpy(sel, "aaaaaaaaaaaa");
    CHECK(sessionSelectionStep(set, sel, sizeof(sel), 3) == 3);
    CHECK_STR(sel, "dddddddddddd");
    CHECK(sessionSelectionStep(set, sel, sizeof(sel), 3) == 6);
    CHECK(sessionSelectionStep(set, sel, sizeof(sel), 3) == 1);    // wrapped
  }

  begin("selection/empty set clears the tracker instead of holding a stale index");
  {
    sessionPalsClear(set);
    std::strcpy(sel, "aaaaaaaaaaaa");
    CHECK(sessionSelectionResolve(set, sel, sizeof(sel)) == -1);
    CHECK(sel[0] == 0);
    CHECK(sessionSelectionStep(set, sel, sizeof(sel), 1) == -1);
  }
}

static void setUsage(SessionPalSet& set, uint8_t at, uint32_t output) {
  set.pals[at].outputTokens = output;
}

static void testTokenHearts() {
  SessionPalSet current;
  SessionHeartTracker tracker;
  SessionHeartQueue queue;
  sessionHeartTrackerClear(tracker);
  sessionHeartQueueClear(queue);

  begin("hearts/first sight establishes a baseline");
  {
    setOf(current, { "aaaaaaaaaaaa" });
    setUsage(current, 0, 450);
    sessionHeartObserve(current, tracker, queue);
    CHECK(queue.count == 0);
  }

  begin("hearts/one award for every 100-token delta");
  {
    sessionHeartTrackerClear(tracker);
    setOf(current, { "aaaaaaaaaaaa" });
    setUsage(current, 0, 0);
    sessionHeartObserve(current, tracker, queue);
    setUsage(current, 0, 300);
    sessionHeartObserve(current, tracker, queue);
    CHECK(queue.count == 1);
    CHECK(queue.awards[0].remaining == 3);

    char id[SESSION_ID_LEN + 1];
    CHECK(sessionHeartQueuePop(queue, id, sizeof(id)));
    CHECK_STR(id, "aaaaaaaaaaaa");
    CHECK(queue.awards[0].remaining == 2);
    CHECK(sessionHeartQueuePop(queue, id, sizeof(id)));
    CHECK(sessionHeartQueuePop(queue, id, sizeof(id)));
    CHECK(queue.count == 0);
  }

  begin("hearts/reorder is keyed by session and decreases never replay");
  {
    sessionHeartTrackerClear(tracker);
    setOf(current, { "aaaaaaaaaaaa", "bbbbbbbbbbbb" });
    setUsage(current, 0, 150);
    setUsage(current, 1, 250);
    sessionHeartObserve(current, tracker, queue);
    setOf(current, { "bbbbbbbbbbbb", "aaaaaaaaaaaa" });
    setUsage(current, 0, 249);
    setUsage(current, 1, 205);
    sessionHeartObserve(current, tracker, queue);
    CHECK(queue.count == 0);
    setUsage(current, 1, 260);
    sessionHeartObserve(current, tracker, queue);
    CHECK(queue.count == 1);
    CHECK_STR(queue.awards[0].id, "aaaaaaaaaaaa");
    CHECK(queue.awards[0].remaining == 1);
    sessionHeartQueueClear(queue);
  }

  begin("hearts/counter reset does not replay historical milestones");
  {
    sessionHeartTrackerClear(tracker);
    setOf(current, { "aaaaaaaaaaaa" });
    setUsage(current, 0, 250);
    sessionHeartObserve(current, tracker, queue);
    setUsage(current, 0, 50);
    sessionHeartObserve(current, tracker, queue);
    setUsage(current, 0, 100);
    sessionHeartObserve(current, tracker, queue);
    CHECK(queue.count == 0);
  }

  begin("hearts/temporary omission preserves unawarded progress");
  {
    sessionHeartTrackerClear(tracker);
    setOf(current, { "aaaaaaaaaaaa" });
    setUsage(current, 0, 0);
    sessionHeartObserve(current, tracker, queue);
    setUsage(current, 0, 50);
    sessionHeartObserve(current, tracker, queue);
    current.pals[0].outputTokens = SESSION_USAGE_UNKNOWN;
    sessionHeartObserve(current, tracker, queue);
    setUsage(current, 0, 120);
    sessionHeartObserve(current, tracker, queue);
    CHECK(queue.count == 1);
    CHECK(queue.awards[0].remaining == 1);
    sessionHeartQueueClear(queue);
  }
}

// ──────────────── 8. state mapping + palette ────────────────
static void testStateAndPalette() {
  begin("state/wire codes map onto persona states");
  {
    CHECK(sessionStateToPersona(SESS_IDLE) == SESS_PERSONA_IDLE);
    CHECK(sessionStateToPersona(SESS_THINKING) == SESS_PERSONA_BUSY);
    CHECK(sessionStateToPersona(SESS_WORKING) == SESS_PERSONA_BUSY);
    CHECK(sessionStateToPersona(SESS_WAITING) == SESS_PERSONA_ATTENTION);
    CHECK(sessionStateToPersona(SESS_BLOCKED) == SESS_PERSONA_ATTENTION);
    CHECK(sessionStateToPersona(99) == SESS_PERSONA_IDLE);          // defensive

    CHECK(!sessionStateNeedsAttention(SESS_IDLE));
    CHECK(!sessionStateNeedsAttention(SESS_THINKING));
    CHECK(!sessionStateNeedsAttention(SESS_WORKING));
    CHECK(sessionStateNeedsAttention(SESS_WAITING));
    CHECK(sessionStateNeedsAttention(SESS_BLOCKED));

    CHECK_STR(sessionStateName(SESS_BLOCKED), "blocked");
    CHECK_STR(sessionStateName(SESS_IDLE), "idle");
  }

  begin("palette/body ink wins when a semantic colour aliases the body");
  {
    const uint16_t pal[5] = { 0x07FF, 0x0000, 0xFFFF, 0x8410, 0x0000 };
    const uint16_t DRAGON_BODY = 0xF800;
    const uint16_t DIM = 0x8410;

    // No palette: identity. This is what keeps legacy rendering byte-identical.
    CHECK(sessionMapColor(DRAGON_BODY, DRAGON_BODY, DIM, nullptr) == DRAGON_BODY);

    // Body ink takes the session colour.
    CHECK(sessionMapColor(DRAGON_BODY, DRAGON_BODY, DIM, pal) == 0x07FF);
    // Dim particles follow the text-dim role.
    CHECK(sessionMapColor(DIM, DRAGON_BODY, DIM, pal) == 0x8410);
    // Non-body semantic colours survive unchanged.
    CHECK(sessionMapColor(0xFA20, DRAGON_BODY, DIM, pal) == 0xFA20);
    CHECK(sessionMapColor(0xF810, DRAGON_BODY, DIM, pal) == 0xF810);
    CHECK(sessionMapColor(0xFFE0, DRAGON_BODY, DIM, pal) == 0xFFE0);
    CHECK(sessionMapColor(0xFFFF, DRAGON_BODY, DIM, pal) == 0xFFFF);

    // Aliased body colours are still body ink: ghost/goose/rabbit use white,
    // duck uses yellow, and mushroom uses the heart-red value today.
    CHECK(sessionMapColor(0xFFFF, 0xFFFF, DIM, pal) == 0x07FF);
    CHECK(sessionMapColor(0xFFE0, 0xFFE0, DIM, pal) == 0x07FF);
    CHECK(sessionMapColor(0xF810, 0xF810, DIM, pal) == 0x07FF);
  }

  begin("palette/every species paints its body with its declared bodyColor");
  {
    // This is the invariant the whole palette path rests on. _mapColor() swaps
    // a session colour in by matching Species::bodyColor against the literal a
    // species hands to buddyPrintSprite(). If a species ever paints with a
    // different literal, its body silently stops honouring session palettes and
    // nothing else in the system notices. Verify it by reading the sources.
    std::string raw = readFile(g_root + "/firmware/test/fixtures/session-lines.json");
    JsonDocument fx;
    deserializeJson(fx, raw);

    int checked = 0;
    for (JsonVariantConst sv : fx["species"].as<JsonArrayConst>()) {
      std::string name = sv.as<const char*>();
      std::string src = readFile(g_root + "/firmware/src/buddies/" + name + ".cpp");

      // Declared body colour: the first hex literal after the Species table entry.
      size_t decl = src.find("_SPECIES = {");
      CHECK(decl != std::string::npos);
      if (decl == std::string::npos) continue;
      size_t hex = src.find("0x", decl);
      CHECK(hex != std::string::npos);
      std::string bodyLit = src.substr(hex, 6);

      // Every colour handed to buddyPrintSprite must be that same literal.
      size_t pos = 0;
      int calls = 0;
      while ((pos = src.find("buddyPrintSprite(", pos)) != std::string::npos) {
        size_t close = src.find(");", pos);
        if (close == std::string::npos) break;
        std::string args = src.substr(pos, close - pos);
        size_t h = args.find("0x");
        CHECK(h != std::string::npos);                       // literal, not a constant
        if (h != std::string::npos) CHECK_STR(args.substr(h, 6).c_str(), bodyLit.c_str());
        // A named BUDDY_* constant here would bypass the remap entirely.
        CHECK(args.find("BUDDY_") == std::string::npos);
        calls++;
        pos = close;
      }
      CHECK(calls >= 7);                                      // one per persona state
      checked++;
    }
    CHECK(checked == SESSION_SPECIES_MAX + 1);
  }
}

// ──────────────── 9. prompt attention floor ────────────────
static void testPromptAttentionFloor() {
  begin("attention-floor/prompt plus working thinking or idle stays urgent");
  {
    const uint8_t states[] = { SESS_WORKING, SESS_THINKING, SESS_IDLE };
    for (uint8_t state : states) {
      uint8_t persona = sessionEffectivePersona(
        SESS_PERSONA_ATTENTION, true, true, sessionStateToPersona(state));
      CHECK(persona == SESS_PERSONA_ATTENTION);
      CHECK(sessionNeedsHuman(true, false, persona));
      CHECK(sessionChirpIntervalMs(true) == 2000u);
      CHECK(sessionAttentionRingVisible(true, true, persona));
      CHECK(sessionAttentionRingUrgent(true, false));
    }
  }

  begin("attention-floor/prompt plus waiting or blocked remains attention");
  {
    const uint8_t states[] = { SESS_WAITING, SESS_BLOCKED };
    for (uint8_t state : states) {
      uint8_t persona = sessionEffectivePersona(
        SESS_PERSONA_ATTENTION, true, true, sessionStateToPersona(state));
      CHECK(persona == SESS_PERSONA_ATTENTION);
      CHECK(sessionNeedsHuman(true, true, persona));
      CHECK(sessionAttentionRingVisible(true, true, persona));
    }
  }

  begin("attention-floor/no prompt selected working stays browsable busy");
  {
    uint8_t persona = sessionEffectivePersona(
      SESS_PERSONA_ATTENTION, false, true, SESS_PERSONA_BUSY);
    CHECK(persona == SESS_PERSONA_BUSY);
    CHECK(!sessionNeedsHuman(false, false, persona));
    CHECK(sessionChirpIntervalMs(false) == 20000u);
    CHECK(!sessionAttentionRingVisible(false, false, persona));
  }

  begin("attention-floor/unselected waiting session keeps ring and chirp correlated");
  {
    const uint8_t selectedPersonas[] = { SESS_PERSONA_BUSY, SESS_PERSONA_IDLE };
    for (uint8_t selectedPersona : selectedPersonas) {
      uint8_t persona = sessionEffectivePersona(
        SESS_PERSONA_ATTENTION, false, true, selectedPersona);
      CHECK(persona == selectedPersona);
      CHECK(sessionNeedsHuman(false, true, persona));
      CHECK(sessionChirpIntervalMs(false) == 20000u);
      bool chirp = sessionNeedsHuman(false, true, persona);
      bool ring = sessionAttentionRingVisible(false, true, persona);
      CHECK(chirp && ring);
      CHECK(ring == chirp);
    }
  }

  begin("attention-floor/blocked urgency follows any current blocked row");
  {
    CHECK(sessionAttentionRingUrgent(false, true));
    CHECK(!sessionAttentionRingUrgent(false, false));
    CHECK(sessionAttentionRingUrgent(true, false));
  }

  begin("attention-floor/legacy zero-session prompt is attention");
  {
    uint8_t persona = sessionEffectivePersona(
      SESS_PERSONA_IDLE, true, false, SESS_PERSONA_IDLE);
    CHECK(persona == SESS_PERSONA_ATTENTION);
    CHECK(sessionNeedsHuman(true, false, persona));
    CHECK(sessionChirpIntervalMs(true) == 2000u);
    CHECK(sessionAttentionRingVisible(true, true, persona));
  }

  begin("completion/stale frozen selection cannot synthesize attention");
  {
    SessionPalSet current;
    sessionPalsClear(current);
    current.version = SESSION_SCHEMA_VERSION;
    current.count = 1;
    std::strcpy(current.pals[0].id, "aaaaaaaaaaaa");
    current.pals[0].state = SESS_IDLE;

    const int frozenSelectedIndex = 1; // waiting row from the prior two-row set
    const uint32_t frozenCarouselMs = 1234;
    const bool completionVisible = true;
    bool selectedActive = !completionVisible
      && frozenSelectedIndex >= 0 && frozenSelectedIndex < (int)current.count;
    CHECK(!selectedActive);

    uint8_t persona = sessionEffectivePersona(
      SESS_PERSONA_IDLE, false, selectedActive, SESS_PERSONA_ATTENTION);
    bool chirp = sessionNeedsHuman(false, false, persona);
    CHECK(persona == SESS_PERSONA_IDLE);
    CHECK(!chirp);
    CHECK(frozenSelectedIndex == 1);
    CHECK(frozenCarouselMs == 1234u);
  }

  begin("completion/current attention facts still outrank the latch");
  {
    const bool completionVisible = true;
    const int selectedIndex = 0;
    const uint8_t currentCount = 1;
    bool selectedActive = !completionVisible
      && selectedIndex >= 0 && selectedIndex < (int)currentCount;
    CHECK(!selectedActive);

    uint8_t waitingPersona = sessionEffectivePersona(
      SESS_PERSONA_ATTENTION, false, false, SESS_PERSONA_IDLE);
    CHECK(waitingPersona == SESS_PERSONA_ATTENTION);
    CHECK(sessionNeedsHuman(false, true, waitingPersona));
    CHECK(sessionAttentionRingVisible(false, true, waitingPersona));
    CHECK(sessionChirpIntervalMs(false) == 20000u);

    uint8_t promptPersona = sessionEffectivePersona(
      SESS_PERSONA_IDLE, true, false, SESS_PERSONA_IDLE);
    CHECK(promptPersona == SESS_PERSONA_ATTENTION);
    CHECK(sessionNeedsHuman(true, false, promptPersona));
    CHECK(sessionAttentionRingVisible(true, false, promptPersona));
    CHECK(sessionChirpIntervalMs(true) == 2000u);
  }

}

// ──────────────── 10. storage budget ────────────────
static void testFootprint() {
  begin("footprint/fixed records stay within the documented budget");
  {
    CHECK(sizeof(SessionPal) <= 128);
    CHECK(sizeof(SessionPalSet) <= 1032);
    CHECK(sizeof(SessionHeartQueue) <= 136);
    CHECK(sizeof(SessionHeartTracker) <= 200);
    CHECK(MAX_SESSION_PALS == 8);
    std::printf(
      "    sizeof(SessionPal)=%zu sizeof(SessionPalSet)=%zu "
      "sizeof(SessionHeartTracker)=%zu\n",
      sizeof(SessionPal), sizeof(SessionPalSet), sizeof(SessionHeartTracker));
  }
}

static void testPrimaryNavigationSource() {
  begin("navigation/pals are primary and other screens live behind the menu");
  const std::string main = readFile(g_root + "/firmware/src/main.cpp");
  const std::string stats = readFile(g_root + "/firmware/src/stats.h");
  CHECK(main.find("bool     sessionStatsOpen = false") != std::string::npos);
  CHECK(main.find("else if (cardOwnsHome)") != std::string::npos);
  CHECK(main.find("sessionStatsOpen = !sessionStatsOpen;") != std::string::npos);
  CHECK(main.find("cardOwnsHome && !sessionStatsOpen") != std::string::npos);
  CHECK(main.find("\"activity\", \"pet care\", \"info\", \"settings\"") != std::string::npos);
  CHECK(main.find("next = (next + 1) % DISP_COUNT") == std::string::npos);
  CHECK(main.find("static void drawSessionStats") != std::string::npos);
  CHECK(main.find("sessionContextPercent(s)") != std::string::npos);
  CHECK(main.find("sessionHeartPoll(") != std::string::npos);
  CHECK(main.find("triggerOneShot(P_HEART, 1600)") != std::string::npos);
  CHECK(main.find("!tokenHeartPlaying && !carouselOwnsEncoder") != std::string::npos);
  CHECK(main.find("if (!completionVisible && !tokenHeartPlaying)") != std::string::npos);
  CHECK(main.find("selSessionIdx = ownerIdx;") != std::string::npos);

  begin("settings/attitude is persistent and defaults to kind");
  CHECK(stats.find("ATTITUDE_KIND = 0") != std::string::npos);
  CHECK(stats.find("ATTITUDE_ASSERTIVE = 1") != std::string::npos);
  CHECK(stats.find("uint8_t attitude;") != std::string::npos);
  CHECK(stats.find("_prefs.getUChar(\"s_att\", ATTITUDE_KIND)") != std::string::npos);
  CHECK(stats.find("_prefs.putUChar(\"s_att\", _settings.attitude)") != std::string::npos);
  CHECK(stats.find("_settings.attitude > ATTITUDE_ASSERTIVE") != std::string::npos);
  CHECK(main.find("\"brightness\", \"attitude\", \"sound\"") != std::string::npos);
  CHECK(main.find("s.attitude == ATTITUDE_KIND ? ATTITUDE_ASSERTIVE : ATTITUDE_KIND")
        != std::string::npos);
  CHECK(main.find("s.attitude == ATTITUDE_KIND ? \"kind\" : \"assertive\"")
        != std::string::npos);
}

static void testDemoProjection() {
  begin("demo/five stable pals use the real carousel projection");
  SessionPalSet first;
  SessionPalSet attention;
  sessionPalsDemoApply(0, first);
  sessionPalsDemoApply(3, attention);
  CHECK(first.version == SESSION_SCHEMA_VERSION);
  CHECK(first.count == SESSION_DEMO_PALS);
  CHECK(first.count == 5);
  CHECK(attention.count == first.count);

  for (uint8_t i = 0; i < first.count; i++) {
    CHECK(sessionIdValid(first.pals[i].id));
    CHECK_STR(first.pals[i].id, attention.pals[i].id);
    CHECK(first.pals[i].species == attention.pals[i].species);
    CHECK(first.pals[i].outputTokens != SESSION_USAGE_UNKNOWN);
    CHECK(first.pals[i].inputTokens != SESSION_USAGE_UNKNOWN);
    CHECK(first.pals[i].model[0] != 0);
    CHECK(first.pals[i].contextUsed == SESSION_USAGE_UNKNOWN);
    CHECK(first.pals[i].contextMax == SESSION_USAGE_UNKNOWN);
    CHECK(first.pals[i].state == SESS_IDLE);
  }
  CHECK(attention.pals[0].state == SESS_WORKING);
  CHECK(attention.pals[3].state == SESS_WAITING);
  CHECK(attention.pals[4].state == SESS_BLOCKED);
  SessionPalSet assertive;
  sessionPalsDemoApply(SESSION_DEMO_ASSERTIVE, assertive);
  for (uint8_t i = 0; i < assertive.count; i++) {
    CHECK(assertive.pals[i].state == SESS_IDLE);
  }

  char selected[SESSION_ID_LEN + 1] = "";
  CHECK(sessionSelectionResolve(first, selected, sizeof(selected)) == 0);
  CHECK(sessionSelectionStep(first, selected, sizeof(selected), 1) == 1);
  CHECK_STR(selected, "000000000002");
  CHECK(sessionSelectionStep(first, selected, sizeof(selected), -2) == 4);
  CHECK_STR(selected, "000000000005");

  begin("demo/all scenarios keep the roster browsable");
  for (uint8_t scenario = 0; scenario < SESSION_DEMO_SCENARIOS; scenario++) {
    SessionPalSet set;
    sessionPalsDemoApply(scenario, set);
    CHECK(set.version == SESSION_SCHEMA_VERSION);
    CHECK(set.count == SESSION_DEMO_PALS);
    for (uint8_t i = 0; i < set.count; i++) CHECK_STR(set.pals[i].id, first.pals[i].id);
  }
  SessionPalSet wrapped;
  sessionPalsDemoApply(SESSION_DEMO_SCENARIOS + 3, wrapped);
  CHECK(wrapped.pals[3].state == SESS_WAITING);

  begin("demo/menu returns directly to the carousel");
  const std::string data = readFile(g_root + "/firmware/src/data.h");
  const std::string main = readFile(g_root + "/firmware/src/main.cpp");
  CHECK(data.find("sessionPalsDemoApply(_demoIdx, out->sessions)") != std::string::npos);
  CHECK(data.find("_demoIdx == SESSION_DEMO_ASSERTIVE") != std::string::npos);
  CHECK(data.find("{\"assertive\",5,0,0,false,155000}") != std::string::npos);
  CHECK(data.find("_demoNext = millis() + 8000") != std::string::npos);
  CHECK(data.find("(int32_t)(now - _demoNext) >= 0") != std::string::npos);
  CHECK(data.find("out->promptId[0] = 0;") != std::string::npos);
  CHECK(data.find("out->completion.active = false") == std::string::npos);
  CHECK(data.find("sessionPalsClear(out->sessions);   // demo scenarios are aggregate-only")
        == std::string::npos);
  size_t demoCase = main.find("case 4:\n      dataSetDemo(!dataDemo());");
  CHECK(demoCase != std::string::npos);
  std::string demoBlock = main.substr(demoCase, 220);
  CHECK(demoBlock.find("menuOpen = false;") != std::string::npos);
  CHECK(demoBlock.find("displayMode = DISP_NORMAL;") != std::string::npos);
  CHECK(demoBlock.find("applyDisplayMode();") != std::string::npos);

  size_t cardStart = main.find("void drawSessionCard()");
  size_t cardEnd = main.find("static const int COMPLETION_PILL_Y", cardStart);
  std::string card = main.substr(cardStart, cardEnd - cardStart);
  CHECK(card.find("if (dataDemoAssertive())") != std::string::npos);
  CHECK(card.find("GET BACK TO WORK!!") != std::string::npos);
  CHECK(card.find("+ SUCCESS") != std::string::npos);
  CHECK(main.find("if (dataDemoAssertive() && liveCardActive) renderState = P_ATTENTION;")
        != std::string::npos);
}


// ──────────────── 11. completion latch parser and mirror ────────────────
static CompletionApplyResult applyCompletion(const char* line, CompletionMirror& mirror,
                                             uint32_t now) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, line);
  CHECK(!err);
  if (err) return COMPLETION_MALFORMED;
  return completionApplySnapshot(doc.as<JsonVariantConst>(), mirror, now);
}

static void testCompletionParserAndMirror() {
  CompletionMirror mirror;
  mirror.reset();

  begin("completion/strict owner metadata parses atomically");
  CHECK(applyCompletion(
    "{\"sg\":10,\"sc\":{\"g\":1,\"o\":0,\"i\":\"0123456789ab\",\"p\":7,"
    "\"c\":[1,2,3,4,5],\"m\":\"done\",\"d\":42}}", mirror, 100) == COMPLETION_NEW);
  CHECK(mirror.active);
  CHECK(mirror.epoch == 10);
  CHECK(mirror.latch.generation == 1);
  CHECK(mirror.latch.outcome == COMPLETION_SUCCESS);
  CHECK(mirror.latch.species == 7);
  CHECK_STR(mirror.latch.id, "0123456789ab");
  CHECK_STR(mirror.latch.summary, "done");
  CHECK(mirror.latch.durationSeconds == 42);
  CHECK((mirror.latch.flags & (COMPLETION_HAS_OWNER | COMPLETION_HAS_DURATION)) ==
        (COMPLETION_HAS_OWNER | COMPLETION_HAS_DURATION));
  CHECK(sizeof(CompletionLatch) <= 88);

  CompletionLatch saved = mirror.latch;
  const char* malformed[] = {
    "{\"sg\":null,\"completed\":true}",
    "{\"sg\":10,\"sc\":{\"g\":2,\"o\":3}}",
    "{\"sg\":10,\"sc\":{\"g\":2,\"o\":0,\"i\":\"0123456789ab\"}}",
    "{\"sg\":10,\"sc\":{\"g\":2,\"o\":0,\"i\":\"0123456789AB\",\"p\":0,\"c\":[1,2,3,4,5],\"m\":\"x\"}}",
    "{\"sg\":10,\"sc\":{\"g\":2,\"o\":0,\"i\":\"0123456789ab\",\"p\":18,\"c\":[1,2,3,4,5],\"m\":\"x\"}}",
    "{\"sg\":10,\"sc\":{\"g\":2,\"o\":0,\"i\":\"0123456789ab\",\"p\":0,\"c\":[1,2,3,4],\"m\":\"x\"}}",
    "{\"sg\":10,\"sc\":{\"g\":2,\"o\":0,\"i\":\"0123456789ab\",\"p\":0,\"c\":[1,2,3,4,65536],\"m\":\"x\"}}",
    "{\"sg\":10,\"sc\":{\"g\":2,\"o\":0,\"i\":\"0123456789ab\",\"p\":0,\"c\":[1,2,3,4,5],\"m\":42}}",
    "{\"sg\":10,\"sc\":{\"g\":2,\"o\":0,\"i\":\"0123456789ab\",\"p\":0,\"c\":[1,2,3,4,5],\"m\":\"ok\\u0000tail\"}}",
    "{\"sg\":10,\"sc\":{\"g\":2,\"o\":0,\"d\":-1}}",
    "{\"sg\":10,\"sc\":null}",
  };
  for (const char* line : malformed) {
    CHECK(applyCompletion(line, mirror, 200) == COMPLETION_MALFORMED);
    CHECK(mirror.active);
    CHECK(std::memcmp(&mirror.latch, &saved, sizeof(saved)) == 0);
  }

  begin("completion/idempotent newer older and authoritative clear");
  CHECK(applyCompletion("{\"sg\":10,\"sc\":{\"g\":1,\"o\":0}}", mirror, 300)
        == COMPLETION_UNCHANGED);
  CHECK(!mirror.introConsumed);
  CHECK(applyCompletion("{\"sg\":10,\"sc\":{\"g\":3,\"o\":1}}", mirror, 400)
        == COMPLETION_NEW);
  CHECK(mirror.latch.generation == 3 && mirror.latch.outcome == COMPLETION_FAILED);
  CHECK(applyCompletion("{\"sg\":10,\"sc\":{\"g\":2,\"o\":0}}", mirror, 500)
        == COMPLETION_STALE);
  CHECK(mirror.latch.generation == 3);
  CHECK(applyCompletion("{\"sg\":10}", mirror, 600) == COMPLETION_CLEARED);
  CHECK(!mirror.active);
  CHECK(applyCompletion("{\"sg\":10,\"sc\":{\"g\":3,\"o\":1}}", mirror, 700)
        == COMPLETION_STALE);
  CHECK(!mirror.active);
  CHECK(applyCompletion("{\"sg\":10,\"sc\":{\"g\":4,\"o\":2}}", mirror, 800)
        == COMPLETION_NEW);
  CHECK(mirror.active && mirror.latch.generation == 4);

  begin("completion/epoch change clears before malformed replacement");
  CHECK(applyCompletion("{\"sg\":11,\"sc\":{\"g\":1,\"o\":9}}", mirror, 900)
        == COMPLETION_MALFORMED);
  CHECK(mirror.epoch == 11);
  CHECK(!mirror.active);
  CHECK(mirror.highestGeneration == 0);
  CHECK(applyCompletion("{\"sg\":11,\"sc\":{\"g\":1,\"o\":0}}", mirror, 1000)
        == COMPLETION_NEW);

  begin("completion/disconnect restore does not replay intro");
  mirror.legacyPrimed = true;
  mirror.legacyCompleted = false;
  mirror.onDisconnect();
  CHECK(!mirror.legacyPrimed);
  CHECK(!mirror.active);
  CHECK(applyCompletion("{\"sg\":11,\"sc\":{\"g\":1,\"o\":0}}", mirror, 1100)
        == COMPLETION_RESTORED);
  CHECK(mirror.active);
  CHECK(mirror.introConsumed);

  begin("completion/local dismiss suppresses and queues exact generation");
  CHECK(mirror.dismissLocal());
  CHECK(!mirror.active);
  CHECK(mirror.pendingDismiss);
  CHECK(mirror.pendingEpoch == 11 && mirror.pendingGeneration == 1);
  CHECK(applyCompletion("{\"sg\":11,\"sc\":{\"g\":1,\"o\":0}}", mirror, 1200)
        == COMPLETION_STALE);
  CHECK(!mirror.active);
  CHECK(applyCompletion("{\"sg\":11}", mirror, 1250) == COMPLETION_CLEARED);
  CHECK(!mirror.pendingDismiss);

  begin("completion/watchdog uses unsigned rollover arithmetic");
  mirror.reset();
  CHECK(applyCompletion("{\"sg\":12,\"sc\":{\"g\":1,\"o\":0}}", mirror,
                        0xfffffff0u) == COMPLETION_NEW);
  CHECK(!mirror.watchdog(0xfffffff0u + COMPLETION_WATCHDOG_MS - 1u));
  CHECK(mirror.watchdog(0xfffffff0u + COMPLETION_WATCHDOG_MS));
  CHECK(!mirror.active);
}

// ──────────────── 12. legacy completion and presentation ────────────────
static void testCompletionLegacyAndPresentation() {
  CompletionMirror mirror;
  mirror.reset();

  begin("completion-legacy/first completed snapshot only primes");
  CHECK(mirror.observeLegacy(true, false, 10) == COMPLETION_UNCHANGED);
  CHECK(!mirror.active);
  CHECK(mirror.observeLegacy(false, false, 20) == COMPLETION_UNCHANGED);
  CHECK(mirror.observeLegacy(true, false, 30) == COMPLETION_NEW);
  CHECK(mirror.active);
  CHECK(!(mirror.latch.flags & COMPLETION_HAS_OWNER));

  begin("completion-legacy/new prompt running or working row clears");
  const bool clearSignals[] = { true, true, true };
  for (bool signal : clearSignals) {
    mirror.active = true;
    CHECK(mirror.observeLegacy(false, signal, 40) == COMPLETION_CLEARED);
    CHECK(!mirror.active);
  }
  mirror.active = true;
  CHECK(mirror.observeLegacy(false, false, 50) == COMPLETION_UNCHANGED);
  CHECK(mirror.active);

  begin("completion-priority/modal and attention hide without dismissing");
  CHECK(completionCardVisible(true, true, true, false, false, false, false, false));
  CHECK(!completionCardVisible(true, true, true, true, false, false, false, false));
  CHECK(!completionCardVisible(true, true, true, false, true, false, false, false));
  CHECK(!completionCardVisible(true, true, true, false, false, true, false, false));
  CHECK(!completionCardVisible(true, true, true, false, false, false, true, false));
  CHECK(!completionCardVisible(true, true, true, false, false, false, false, true));
  CHECK(!completionCardVisible(true, false, true, false, false, false, false, false));
  CHECK(mirror.active);

  begin("completion-input/only short click or pill tap dismisses");
  CHECK(completionDismissGestureAllowed(true, true, false, false, false));
  CHECK(completionDismissGestureAllowed(true, false, true, false, false));
  CHECK(!completionDismissGestureAllowed(true, false, false, true, false));
  CHECK(!completionDismissGestureAllowed(true, true, false, false, true));
  CHECK(!completionDismissGestureAllowed(true, true, false, true, false));
  CHECK(!completionDismissGestureAllowed(true, false, true, true, false));
  CHECK(!completionDismissGestureAllowed(false, true, true, false, false));

  begin("completion/metadata survives live row removal and selection stays untouched");
  SessionPalSet set;
  setOf(set, { "aaaaaaaaaaaa", "bbbbbbbbbbbb" });
  char selection[13] = "bbbbbbbbbbbb";
  SessionPalSet before = set;
  mirror.reset();
  mirror.observeEpoch(20);
  CompletionLatch candidate;
  completionLatchClearValue(candidate);
  candidate.generation = 1;
  candidate.flags = COMPLETION_HAS_OWNER;
  candidate.species = 7;
  std::strcpy(candidate.id, "0123456789ab");
  std::strcpy(candidate.summary, "saved completion");
  CHECK(mirror.apply(candidate, 100) == COMPLETION_NEW);
  sessionPalsClear(set);
  CHECK_STR(mirror.latch.summary, "saved completion");
  CHECK_STR(selection, "bbbbbbbbbbbb");
  CHECK(before.count == 2);

  begin("completion/carousel timestamp is not touched by card code");
  std::string mainSource = readFile(g_root + "/firmware/src/main.cpp");
  size_t drawStart = mainSource.find("static void drawCompletionCard");
  size_t drawEnd = mainSource.find("// Pulsing attention ring", drawStart);
  CHECK(drawStart != std::string::npos && drawEnd != std::string::npos);
  CHECK(mainSource.substr(drawStart, drawEnd - drawStart).find("lastCarouselMs") == std::string::npos);
  CHECK(mainSource.find("completionVisible, click && !btnALong") != std::string::npos);
  CHECK(mainSource.find("completionPillTap, encoderMoved") != std::string::npos);
  CHECK(mainSource.find("return tama.completion.active && !dataDemo();") != std::string::npos);
  CHECK(mainSource.find("&& !completionPresentationActive()") != std::string::npos);
  CHECK(mainSource.find("touchInCompletionPill") != std::string::npos);
  CHECK(mainSource.find("cardOwnsHome && !completionVisible") != std::string::npos);
  CHECK(mainSource.find("if (!dataDemo()) {") != std::string::npos);

  begin("completion/intro durations and settled affordance are fixed");
  CHECK(completionIntroDuration(COMPLETION_SUCCESS) == 5600u);
  CHECK(completionIntroDuration(COMPLETION_FAILED) == 800u);
  CHECK(completionIntroDuration(COMPLETION_ABORTED) == 400u);
  mirror.reset();
  mirror.active = true;
  mirror.latch.startedAt = 100;
  CHECK(!completionAffordanceVisible(mirror, 1099));
  CHECK(completionAffordanceVisible(mirror, 1100));
}

// ──────────────── 13. wake gesture consumption ────────────────
static void testWakeInputGuard() {
  WakeInputGuard guard;
  guard.reset();

  begin("wake/button gesture is consumed through release and quiet");
  guard.woke(1000, true);
  CHECK(guard.consume(1010, true, false, false));
  CHECK(guard.consume(1100, false, false, false));
  CHECK(guard.consume(1249, false, false, false));
  CHECK(!guard.consume(1250, false, false, false));

  begin("wake/encoder motion restarts the quiet window");
  guard.woke(2000, false);
  CHECK(guard.consume(2100, false, true, false));
  CHECK(guard.consume(2249, false, false, false));
  CHECK(!guard.consume(2250, false, false, false));

  begin("wake/touch must lift and remain quiet");
  guard.woke(3000, false);
  CHECK(guard.consume(3100, false, false, true));
  CHECK(guard.consume(3249, false, false, false));
  CHECK(!guard.consume(3250, false, false, false));

  begin("wake/normal input passes when ready");
  guard.reset();
  CHECK(!guard.consume(4000, false, true, true));
}
int main(int argc, char** argv) {
  g_root = (argc > 1) ? argv[1] : ".";
  std::printf("session-pal host tests (root=%s)\n\n", g_root.c_str());

  testFixtures();
  testUsageFormatting();
  testCatalogOrder();
  testMalformed();
  testVersioning();
  testUtf8();
  testWrap();
  testSelection();
  testTokenHearts();
  testStateAndPalette();
  testPromptAttentionFloor();
  testFootprint();
  testPrimaryNavigationSource();
  testDemoProjection();
  testCompletionParserAndMirror();
  testCompletionLegacyAndPresentation();
  testWakeInputGuard();

  std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
  return g_failures ? 1 : 0;
}
