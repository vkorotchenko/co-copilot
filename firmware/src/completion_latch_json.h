#pragma once
#include <ArduinoJson.h>
#include "completion_latch.h"

inline CompletionApplyResult completionApplySnapshot(JsonVariantConst doc,
                                                      CompletionMirror& mirror,
                                                      uint32_t now) {
  JsonVariantConst epochValue = doc["sg"];
  if (epochValue.isUnbound()) return COMPLETION_NO_MODERN;
  if (!epochValue.is<uint32_t>()) return COMPLETION_MALFORMED;
  const uint32_t epoch = epochValue.as<uint32_t>();
  if (epoch == 0) return COMPLETION_MALFORMED;
  mirror.observeEpoch(epoch);

  JsonVariantConst scValue = doc["sc"];
  if (scValue.isUnbound()) return mirror.authoritativeClear();
  JsonObjectConst sc = scValue.as<JsonObjectConst>();
  if (sc.isNull()) return COMPLETION_MALFORMED;

  JsonVariantConst generationValue = sc["g"];
  JsonVariantConst outcomeValue = sc["o"];
  if (!generationValue.is<uint32_t>() || !outcomeValue.is<uint32_t>()) {
    return COMPLETION_MALFORMED;
  }
  const uint32_t outcome = outcomeValue.as<uint32_t>();
  if (outcome > COMPLETION_ABORTED) return COMPLETION_MALFORMED;

  const char* ownerKeys[] = { "i", "p", "c", "m" };
  uint8_t ownerFields = 0;
  for (const char* key : ownerKeys) if (!sc[key].isUnbound()) ownerFields++;
  if (ownerFields != 0 && ownerFields != 4) return COMPLETION_MALFORMED;

  CompletionLatch candidate;
  completionLatchClearValue(candidate);
  candidate.generation = generationValue.as<uint32_t>();
  candidate.outcome = (uint8_t)outcome;

  if (ownerFields == 4) {
    const char* id = sc["i"];
    JsonVariantConst speciesValue = sc["p"];
    JsonArrayConst colors = sc["c"];
    JsonString summary = sc["m"].as<JsonString>();
    if (!completionIdValid(id) || !speciesValue.is<uint32_t>()
        || speciesValue.as<uint32_t>() > 17 || colors.isNull() || colors.size() != 5
        || !sc["m"].is<const char*>()
        || !completionUtf8Valid48(summary.c_str(), summary.size())) {
      return COMPLETION_MALFORMED;
    }
    uint8_t colorIndex = 0;
    for (JsonVariantConst color : colors) {
      if (!color.is<uint32_t>() || color.as<uint32_t>() > 0xffffu) return COMPLETION_MALFORMED;
      candidate.colors[colorIndex++] = (uint16_t)color.as<uint32_t>();
    }
    memcpy(candidate.id, id, sizeof(candidate.id));
    memcpy(candidate.summary, summary.c_str(), summary.size());
    candidate.summary[summary.size()] = 0;
    candidate.species = (uint8_t)speciesValue.as<uint32_t>();
    candidate.flags |= COMPLETION_HAS_OWNER;
  }

  if (!sc["d"].isUnbound()) {
    JsonVariantConst durationValue = sc["d"];
    if (!durationValue.is<uint32_t>()) return COMPLETION_MALFORMED;
    candidate.durationSeconds = durationValue.as<uint32_t>();
    candidate.flags |= COMPLETION_HAS_DURATION;
  }
  return mirror.apply(candidate, now);
}
