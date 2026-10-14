#pragma once
// ES8311 codec on I2S, with an amplifier enable pin. Header-only: only a board that includes it
// builds it.
#include <Arduino.h>
#include <ESP_I2S.h>
#include <cstdint>
#include "es8311/es8311.h"

namespace copilot {
namespace board {
struct Es8311Config {
  int mclkPin;
  int bclkPin;
  int wordSelectPin;
  int dataOutPin;
  int amplifierPin;
  unsigned i2cPort;
  uint8_t i2cAddress;
  // The codec volume for 1% and for 100% sound volume.
  int minimumVolume;
  int maximumVolume;
};

class Es8311AudioOutput {
 public:
  explicit Es8311AudioOutput(const Es8311Config& config) : config_(config) {}

  // Starts 16-bit stereo output. Returns nullptr, or a short error tag for the AUDIO log.
  const char* begin(unsigned sampleRate) {
    pinMode(config_.amplifierPin, OUTPUT);
    digitalWrite(config_.amplifierPin, LOW);
    i2s_.setPins(config_.bclkPin, config_.wordSelectPin, config_.dataOutPin, -1, config_.mclkPin);
    if (!i2s_.begin(I2S_MODE_STD, sampleRate, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO,
                    I2S_STD_SLOT_BOTH))
      return "i2s-init";

    codec_ = es8311_create(config_.i2cPort, config_.i2cAddress);
    const es8311_clock_config_t clock = {
        .mclk_inverted = false,
        .sclk_inverted = false,
        .mclk_from_mclk_pin = true,
        .mclk_frequency = static_cast<int>(sampleRate * 256),
        .sample_frequency = static_cast<int>(sampleRate),
    };
    if (!codec_ || es8311_init(codec_, &clock, ES8311_RESOLUTION_16, ES8311_RESOLUTION_16) != ESP_OK ||
        es8311_sample_frequency_config(codec_, clock.mclk_frequency, clock.sample_frequency) != ESP_OK ||
        es8311_voice_fade(codec_, ES8311_FADE_64LRCK) != ESP_OK ||
        es8311_voice_mute(codec_, true) != ESP_OK) {
      if (codec_) {
        es8311_delete(codec_);
        codec_ = nullptr;
      }
      i2s_.end();
      return "codec-init";
    }
    return nullptr;
  }

  // Sets the volume (1-100), then turns on the amplifier and unmutes the codec.
  bool enable(uint8_t volume) {
    if (es8311_voice_volume_set(codec_, codecVolume(volume), nullptr) != ESP_OK) return false;
    digitalWrite(config_.amplifierPin, HIGH);
    delay(4);
    if (es8311_voice_mute(codec_, false) != ESP_OK) {
      digitalWrite(config_.amplifierPin, LOW);
      return false;
    }
    return true;
  }

  bool write(const uint8_t* data, size_t size) {
    while (size > 0) {
      const size_t written = i2s_.write(data, size);
      if (written == 0) return false;
      data += written;
      size -= written;
    }
    return true;
  }

  int mclkPin() const { return config_.mclkPin; }

  // Mutes the codec, then turns off the amplifier.
  void disable() {
    es8311_voice_mute(codec_, true);
    delay(2);
    digitalWrite(config_.amplifierPin, LOW);
  }

 private:
  int codecVolume(uint8_t volume) const {
    return config_.minimumVolume + (volume * (config_.maximumVolume - config_.minimumVolume) + 50) / 100;
  }

  Es8311Config config_;
  I2SClass i2s_;
  es8311_handle_t codec_ = nullptr;
};
}  // namespace board
}  // namespace copilot
