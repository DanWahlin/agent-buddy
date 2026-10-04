#include "OrientedDisplay.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <esp_heap_caps.h>

namespace copilot {
OrientedDisplay::OrientedDisplay(Arduino_CO5300* panel, Arduino_DataBus* bus)
    : Arduino_Canvas(kDisplaySize, kDisplaySize, nullptr), panel_(panel), bus_(bus) {}

OrientedDisplay::~OrientedDisplay() {
  free(rotatedFramebuffer_);
}

bool OrientedDisplay::begin(int32_t speed) {
  if (!panel_->begin(speed)) return false;
  if (!_framebuffer) {
    _framebuffer = static_cast<uint16_t*>(heap_caps_aligned_alloc(
        16, kDisplaySize * kDisplaySize * sizeof(uint16_t),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  }
  if (!rotatedFramebuffer_) {
    rotatedFramebuffer_ = static_cast<uint16_t*>(heap_caps_aligned_alloc(
        16, kDisplaySize * kDisplaySize * sizeof(uint16_t),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  }
  return _framebuffer != nullptr && rotatedFramebuffer_ != nullptr;
}

void OrientedDisplay::flush(bool forceFlush) {
  (void)forceFlush;
  flushSource(_framebuffer, 0, 0, kDisplaySize, kDisplaySize);
}

void OrientedDisplay::flushFrame(
    const uint16_t* pixels, int x, int y, int width, int height) {
  flushSource(pixels, x, y, width, height);
}

void OrientedDisplay::flushSource(
    const uint16_t* pixels, int sourceOriginX, int sourceOriginY, int width, int height) {
  if (!pixels || !transferBuffer_ || transferBytes_ < sizeof(uint16_t)) return;

  constexpr int32_t kFixedOne = INT32_C(1) << 16;
  constexpr int32_t kFixedHalf = kFixedOne / 2;
  constexpr int32_t center = (kDisplaySize - 1) * kFixedHalf;
  const int32_t cosine = std::lround(std::cos(angle_) * kFixedOne);
  const int32_t sine = std::lround(std::sin(angle_) * kFixedOne);
  auto* output = reinterpret_cast<uint16_t*>(transferBuffer_);
  const size_t outputPixels = transferBytes_ / sizeof(uint16_t);

  panel_->startWrite();
  constexpr int32_t kCardinalSnapEnter = 2287;  // About two degrees.
  constexpr int32_t kCardinalSnapExit = 5712;   // About five degrees.
  if (snappedUpright_ && (cosine < 0 || std::abs(sine) >= kCardinalSnapExit))
    snappedUpright_ = false;
  if (!snappedUpright_ && cosine >= 0 && std::abs(sine) < kCardinalSnapEnter)
    snappedUpright_ = true;
  if (snappedUpright_) {
    panel_->writeAddrWindow(0, 0, kDisplaySize, kDisplaySize);
    if (sourceOriginX == 0 && sourceOriginY == 0
        && width == kDisplaySize && height == kDisplaySize) {
      const auto* source = reinterpret_cast<const uint8_t*>(pixels);
      constexpr size_t frameBytes = kDisplaySize * kDisplaySize * sizeof(uint16_t);
      for (size_t offset = 0; offset < frameBytes; offset += transferBytes_) {
        const size_t count = std::min(transferBytes_, frameBytes - offset);
        std::memcpy(transferBuffer_, source + offset, count);
        bus_->writeBytes(transferBuffer_, count);
      }
    } else {
      constexpr int kRowsPerBatch = 4;
      if (outputPixels < kDisplaySize * kRowsPerBatch) {
        panel_->endWrite();
        return;
      }
      for (int batchY = 0; batchY < kDisplaySize; batchY += kRowsPerBatch) {
        const int rows = std::min(kRowsPerBatch, kDisplaySize - batchY);
        std::fill(output, output + rows * kDisplaySize, 0);
        const int firstSourceRow = std::max(batchY, sourceOriginY);
        const int lastSourceRow = std::min(batchY + rows, sourceOriginY + height);
        for (int sourceY = firstSourceRow; sourceY < lastSourceRow; ++sourceY) {
          std::memcpy(output + (sourceY - batchY) * kDisplaySize + sourceOriginX,
                      pixels + (sourceY - sourceOriginY) * width,
                      width * sizeof(uint16_t));
        }
        bus_->writeBytes(transferBuffer_, rows * kDisplaySize * sizeof(uint16_t));
      }
    }
    panel_->endWrite();
    return;
  }
  panel_->writeAddrWindow(0, 0, kDisplaySize, kDisplaySize);

  for (int destinationY = 0; destinationY < kDisplaySize; destinationY += 2) {
      const int32_t dx = -center + kFixedHalf;
      const int32_t dy = destinationY * kFixedOne - center + kFixedHalf;
      int32_t sourceX = center + static_cast<int32_t>(
          (static_cast<int64_t>(cosine) * dx + static_cast<int64_t>(sine) * dy) >> 16);
      int32_t sourceY = center + static_cast<int32_t>(
          (-static_cast<int64_t>(sine) * dx + static_cast<int64_t>(cosine) * dy) >> 16);
      auto* firstRow = rotatedFramebuffer_ + destinationY * kDisplaySize;
      auto* secondRow =
          destinationY + 1 < kDisplaySize ? firstRow + kDisplaySize : nullptr;
      for (int destinationX = 0; destinationX < kDisplaySize; destinationX += 2) {
        uint16_t pixel = 0;
        const int sourcePixelX = static_cast<int>((sourceX + kFixedHalf) >> 16);
        const int sourcePixelY = static_cast<int>((sourceY + kFixedHalf) >> 16);
        if (sourcePixelX >= 0 && sourcePixelX < kDisplaySize
            && sourcePixelY >= 0 && sourcePixelY < kDisplaySize) {
          if (sourcePixelX >= sourceOriginX && sourcePixelX < sourceOriginX + width
              && sourcePixelY >= sourceOriginY && sourcePixelY < sourceOriginY + height) {
            pixel = pixels[(sourcePixelY - sourceOriginY) * width
                           + sourcePixelX - sourceOriginX];
          }
        }
        firstRow[destinationX] = pixel;
        if (destinationX + 1 < kDisplaySize) firstRow[destinationX + 1] = pixel;
        if (secondRow) {
          secondRow[destinationX] = pixel;
          if (destinationX + 1 < kDisplaySize) secondRow[destinationX + 1] = pixel;
        }
        sourceX += cosine * 2;
        sourceY -= sine * 2;
      }
  }
  bus_->writeBytes(reinterpret_cast<uint8_t*>(rotatedFramebuffer_),
                   kDisplaySize * kDisplaySize * sizeof(uint16_t));
  panel_->endWrite();
}
}
