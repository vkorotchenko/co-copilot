#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Decode one sequence. Returns its byte length (1..4) or 0 when the bytes are
// not well-formed UTF-8. Rejects overlong encodings, surrogates, and anything
// above U+10FFFF so a hostile line can never smuggle a broken code point into
// fixed-width storage.
inline uint8_t sessionUtf8Decode(const uint8_t* s, size_t avail, uint32_t* cpOut) {
  if (avail == 0) return 0;
  uint8_t c = s[0];
  uint32_t cp;
  uint8_t  n;
  if (c < 0x80)                   { cp = c;          n = 1; }
  else if ((c & 0xE0) == 0xC0)    { cp = c & 0x1Fu;  n = 2; }
  else if ((c & 0xF0) == 0xE0)    { cp = c & 0x0Fu;  n = 3; }
  else if ((c & 0xF8) == 0xF0)    { cp = c & 0x07u;  n = 4; }
  else return 0;
  if (avail < n) return 0;
  for (uint8_t i = 1; i < n; i++) {
    if ((s[i] & 0xC0) != 0x80) return 0;
    cp = (cp << 6) | (uint32_t)(s[i] & 0x3Fu);
  }
  static const uint32_t MIN_CP[5] = { 0, 0x0, 0x80, 0x800, 0x10000 };
  if (cp < MIN_CP[n]) return 0;
  if (cp > 0x10FFFF) return 0;
  if (cp >= 0xD800 && cp <= 0xDFFF) return 0;
  if (cpOut) *cpOut = cp;
  return n;
}

// Copy a UTF-8 string into fixed storage, stopping on a code-point boundary and
// never emitting a partial sequence. Invalid input truncates at the first bad
// byte rather than propagating garbage. `cap` includes the NUL.
inline size_t sessionUtf8Clamp(const char* src, char* dst, size_t cap) {
  if (cap == 0) return 0;
  dst[0] = 0;
  if (!src || cap == 1) return 0;
  size_t len = strlen(src);
  size_t in = 0, out = 0;
  const uint8_t* p = (const uint8_t*)src;
  while (in < len) {
    uint8_t n = sessionUtf8Decode(p + in, len - in, nullptr);
    if (n == 0) break;
    if (out + n > cap - 1) break;
    memcpy(dst + out, p + in, n);
    out += n;
    in  += n;
  }
  dst[out] = 0;
  return out;
}
