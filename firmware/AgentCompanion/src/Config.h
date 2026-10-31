#pragma once
#include <cstddef>
#include <cstdint>
#include "boards/BoardConfig.h"

// Board pins, panel size, and chip addresses are in boards/<board>/BoardConfig.h.
namespace copilot {
// kDisplaySize is the content size on every board. The panel is kPanelWidth x kPanelHeight, and it
// shows the content at kShownContentSize around its center (see ScreenTransform.h). At full size, a
// panel narrower or shorter than the content shows its middle; a smaller size scales the content
// down by up to half, averaging 2x2 blocks.
static_assert(kPanelWidth > 0 && kPanelHeight > 0, "The panel needs a width and a height.");
static_assert(kShownContentSize > 0 && kShownContentSize <= kDisplaySize
                  && 2 * kShownContentSize >= kDisplaySize,
              "The panel must show the content at full size or down to half size.");
// At full size, upright frames go straight to the panel, so content pixels must land on panel pixels.
static_assert(kShownContentSize < kDisplaySize
                  || ((kPanelWidth - kDisplaySize) % 2 == 0 && (kPanelHeight - kDisplaySize) % 2 == 0),
              "At full size, the panel and the content must differ by an even number of pixels.");
// Where the content's top-left corner is on the panel when the panel shows it at full size.
constexpr int kPanelContentX = (kPanelWidth - kDisplaySize) / 2;
constexpr int kPanelContentY = (kPanelHeight - kDisplaySize) / 2;
// A panel that shows the content smaller uses the compact settings layout and one size larger text.
constexpr bool kCompactUi = kShownContentSize < kDisplaySize;
constexpr int kFrameWidth = 400;
constexpr int kFrameHeight = 352;
constexpr int kFrameX = (kDisplaySize - kFrameWidth) / 2;
constexpr int kFrameY = (kDisplaySize - kFrameHeight) / 2;
constexpr int kCharacterFrameHeight = kDisplaySize;
constexpr int kCharacterFrameWidth = 412;
constexpr int kCharacterFrameX = (kDisplaySize - kCharacterFrameWidth) / 2;
constexpr int kCharacterArtX = (kCharacterFrameWidth - kFrameWidth) / 2;
constexpr int kTargetFps = 30;
constexpr unsigned kAudioSampleRate = 24000;
constexpr uint8_t kDefaultSoundVolume = 50;
constexpr unsigned kTouchDebounceMs = 180;
constexpr int kTouchTapTravelPixels = 24;
constexpr unsigned kTouchTapMaxMs = 650;
constexpr int kTouchSwipePixels = 72;
constexpr unsigned kTouchSwipeMaxMs = 1200;
constexpr unsigned kTouchSweepMs = 250;
constexpr unsigned kOrientationPollMs = 16;
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
