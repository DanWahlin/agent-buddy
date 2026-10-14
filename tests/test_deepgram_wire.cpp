#include "../firmware/AgentCompanion/src/DeepgramWire.h"

#include <cassert>
#include <cstring>
#include <iostream>
#include <string>

using namespace copilot;

static const char* config(const std::string& body, char* key, char* model) {
  return parseDeepgramConfig(body.data(), body.size(), key, kMaxDeepgramKeyBytes + 1,
                             model, kMaxDeepgramModelBytes + 1);
}

int main() {
  const std::string key = "0123456789abcdef0123456789abcdef01234567";
  assert(validDeepgramKey(key.data(), key.size()));
  assert(!validDeepgramKey("short", 5));
  assert(!validDeepgramKey("has a space in this key ok", 26));
  assert(!validDeepgramKey(std::string(129, 'a').data(), 129));

  assert(validFluxModel("flux-haley-en", 13));
  assert(!validFluxModel("flux--en", 8));
  assert(!validFluxModel("aura-2-thalia-en", 16));
  assert(!validFluxModel("flux-Haley-en", 13));
  assert(!validFluxModel("flux-haley-es", 13));
  assert(!validFluxModel("flux-ha&ley-en", 14));

  char parsedKey[kMaxDeepgramKeyBytes + 1];
  char parsedModel[kMaxDeepgramModelBytes + 1];
  assert(config(key + "\nflux-cole-en\n", parsedKey, parsedModel) == nullptr);
  assert(key == parsedKey);
  assert(std::strcmp(parsedModel, "flux-cole-en") == 0);
  assert(config("\nflux-cole-en", parsedKey, parsedModel) == nullptr);
  assert(parsedKey[0] == '\0');
  assert(config(key, parsedKey, parsedModel) != nullptr);
  assert(config("bad key\nflux-cole-en", parsedKey, parsedModel) != nullptr);
  assert(config(key + "\nflux-cole-en&x=1", parsedKey, parsedModel) != nullptr);

  assert(validSpeakText("Hello there", 11));
  assert(validSpeakText("Caf\xc3\xa9 time", 10));
  assert(!validSpeakText("", 0));
  assert(!validSpeakText("   ", 3));
  assert(!validSpeakText("line\nbreak", 10));
  assert(!validSpeakText(std::string(501, 'a').data(), 501));

  char body[kMaxSpeakBodyBytes];
  const std::string text = "Say \"hi\" \\ now\t\xc3\xa9";
  const size_t length = buildSpeakBody(text.data(), text.size(), body, sizeof(body));
  assert(length == std::strlen(body));
  assert(std::string(body) == "{\"text\":\"Say \\\"hi\\\" \\\\ now\\u0009\xc3\xa9\"}");
  const std::string longest(kMaxSpeakTextBytes, '"');
  assert(buildSpeakBody(longest.data(), longest.size(), body, sizeof(body)) != 0);
  char small[12];
  assert(buildSpeakBody(text.data(), text.size(), small, sizeof(small)) == 0);

  char path[160];
  assert(buildSpeakPath("flux-haley-en", path, sizeof(path)));
  assert(std::string(path)
         == "/v2/speak?model=flux-haley-en&encoding=linear16&sample_rate=24000&container=none");
  assert(!buildSpeakPath("flux-haley-en&x", path, sizeof(path)));
  assert(!buildSpeakPath("flux-haley-en", path, 20));

  size_t offset = 0;
  size_t bytes = 0;
  const uint8_t raw[] = {1, 0, 2, 0, 3};
  assert(findDeepgramPcm(raw, sizeof(raw), offset, bytes) && offset == 0 && bytes == 4);
  uint8_t wav[48] = {};
  std::memcpy(wav, "RIFF\xff\xff\xff\xffWAVEfmt ", 16);
  wav[16] = 16;
  std::memcpy(wav + 36, "data\xff\xff\xff\xff", 8);
  assert(findDeepgramPcm(wav, sizeof(wav), offset, bytes) && offset == 44 && bytes == 4);
  assert(!findDeepgramPcm(wav, 44, offset, bytes));
  assert(!findDeepgramPcm(raw, 1, offset, bytes));

  std::cout << "Deepgram wire tests passed\n";
}
