#pragma once
#include <cstddef>
#include <cstdint>

namespace copilot {
constexpr int kDisplaySize = 466;
constexpr int kFrameWidth = 400;
constexpr int kFrameHeight = 352;
constexpr int kFrameX = (kDisplaySize - kFrameWidth) / 2;
constexpr int kFrameY = (kDisplaySize - kFrameHeight) / 2;
constexpr int kCharacterFrameHeight = kDisplaySize;
constexpr int kCharacterFrameWidth = 412;
constexpr int kCharacterFrameX = (kDisplaySize - kCharacterFrameWidth) / 2;
constexpr int kCharacterArtX = (kCharacterFrameWidth - kFrameWidth) / 2;
constexpr int kTargetFps = 30;
constexpr int kSpriteDrawWidth = 396;
constexpr int kBrightness = 155;
constexpr int kAudioMclkPin = 42;
constexpr int kAudioBclkPin = 9;
constexpr int kAudioWordSelectPin = 45;
constexpr int kAudioDataOutPin = 8;
constexpr int kAudioAmplifierPin = 46;
constexpr unsigned kAudioSampleRate = 24000;
constexpr uint8_t kDefaultSoundVolume = 50;
constexpr int kAudioMinimumCodecVolume = 68;
constexpr int kAudioMaximumCodecVolume = 82;
constexpr int kSpiFrequency = 80000000;
constexpr int kTouchSda = 15;
constexpr int kTouchScl = 14;
constexpr int kTouchInterrupt = 11;
constexpr int kTouchReset = 40;
constexpr unsigned kTouchDebounceMs = 180;
constexpr int kTouchTapTravelPixels = 24;
constexpr unsigned kTouchTapMaxMs = 650;
constexpr int kTouchSwipePixels = 72;
constexpr unsigned kTouchSwipeMaxMs = 1200;
constexpr unsigned kTouchSweepMs = 250;
// The BOOT button. Held at power-on it starts the ROM downloader; after that it is free to read.
constexpr int kBootButtonPin = 0;
constexpr unsigned kButtonDebounceMs = 30;
constexpr unsigned kSettingsIdleTimeoutMs = 30000;
constexpr unsigned kCharacterUploadStallMs = 500;
constexpr unsigned kCharacterUploadKicks = 3;
constexpr unsigned kCharacterUploadQuietMs = 300;
constexpr unsigned kCharacterUploadRetries = 8;
constexpr size_t kCharacterUploadChunkBytes = 4096;
constexpr size_t kCharacterUploadRxBufferBytes = kCharacterUploadChunkBytes + 512;
constexpr unsigned kRenderPauseTimeoutMs = 1000;
// Internal RAM that a character's blink buffers must leave free. Measured on the device: the render
// task, Wi-Fi, and TCP/IP take about 130 KB after the buffers, and Wi-Fi needs about 40 KB spare
// while it runs, or it can't send packets.
constexpr size_t kPatchInternalReserveBytes = 176 * 1024;
constexpr uint16_t kNetworkDiscoveryPort = 4666;
constexpr float kHeadDelay = 0.09f;
constexpr float kMoveMin = 1.15f;
constexpr float kMoveMax = 1.65f;
constexpr float kHoldMin = 0.85f;
constexpr float kHoldMax = 2.8f;
constexpr float kBlinkMin = 2.6f;
constexpr float kBlinkMax = 6.2f;
constexpr float kBlinkClose = 0.065f;
constexpr float kBlinkHold = 0.028f;
constexpr float kBlinkOpen = 0.125f;
constexpr float kBlinkDuration = kBlinkClose + kBlinkHold + kBlinkOpen;
static_assert(kTargetFps > 0 && kTargetFps <= 60, "Frame rate must be between 1 and 60.");
static_assert(kBrightness >= 0 && kBrightness <= 255, "Brightness must be between 0 and 255.");
}
