#include "OrientedDisplay.h"
#include <algorithm>
#include <cstring>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <esp_memory_utils.h>

namespace copilot {
OrientedDisplay::OrientedDisplay(Arduino_CO5300* panel, Arduino_DataBus* bus)
    : Arduino_Canvas(kDisplaySize, kDisplaySize, nullptr), panel_(panel), bus_(bus) {}

bool OrientedDisplay::begin(int32_t speed) {
  error_ = nullptr;
  if (!panel_->begin(speed)) {
    error_ = "CO5300 initialization failed.";
    return false;
  }
  if (!_framebuffer) {
    _framebuffer = static_cast<uint16_t*>(heap_caps_aligned_alloc(
        16, kDisplaySize * kDisplaySize * sizeof(uint16_t),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  }
  if (!_framebuffer) error_ = "Orientation canvas allocation failed.";
  if (!error_ && !dma_.begin(speed)) error_ = dma_.error();
  return error_ == nullptr;
}

bool OrientedDisplay::setTransferBuffer(uint8_t* buffer, size_t bytes) {
  error_ = nullptr;
  if (!buffer || reinterpret_cast<uintptr_t>(buffer) % alignof(uint32_t)
      || !esp_ptr_dma_capable(buffer) || bytes < 2 * kDisplaySize * sizeof(uint16_t)
      || bytes % (2 * alignof(uint32_t))) {
    error_ = "Invalid display transfer buffer.";
    return false;
  }
  transferBuffer_ = buffer;
  transferBytes_ = bytes;
  dma_.setBuffer(buffer, bytes);
  return true;
}

bool OrientedDisplay::setAngle(float angle) {
  if (!orientation_.update(angle)) return false;
  frameMarginsDirty_ = true;
  return true;
}

bool OrientedDisplay::setTrim(float radians) {
  if (!std::isfinite(radians) || radians == trim_) return false;
  trim_ = radians;
  frameMarginsDirty_ = true;
  return true;
}

void OrientedDisplay::flush(bool forceFlush) {
  (void)forceFlush;
  frameMarginsDirty_ = true;
  flushSource({_framebuffer, 0, 0, kDisplaySize, kDisplaySize, Rgb565Order::Native});
}

bool OrientedDisplay::flushFrame(
    const uint16_t* pixels, int x, int y, int width, int height) {
  return flushSource({pixels, x, y, width, height, Rgb565Order::Display});
}

bool OrientedDisplay::flushSource(const ScreenPixels& source) {
  error_ = nullptr;
  composeUs_ = writeUs_ = 0;
  if (!transferBuffer_ || !source.pixels || source.x < 0 || source.y < 0
      || source.width <= 0 || source.height <= 0
      || source.x >= kDisplaySize || source.y >= kDisplaySize
      || source.width > kDisplaySize - source.x || source.height > kDisplaySize - source.y) {
    error_ = "Invalid display source or uninitialized transfer buffer.";
    return false;
  }

  // Upright character frames keep the original direct, DMA-staged transfer.
  if (angle() == 0.0f && source.order == Rgb565Order::Display) {
    if (frameMarginsDirty_) {
      panel_->fillRect(0, 0, kDisplaySize, source.y, 0);
      panel_->fillRect(0, source.y + source.height, kDisplaySize,
                       kDisplaySize - source.y - source.height, 0);
      panel_->fillRect(0, source.y, source.x, source.height, 0);
      panel_->fillRect(source.x + source.width, source.y,
                       kDisplaySize - source.x - source.width, source.height, 0);
      frameMarginsDirty_ = false;
    }
    panel_->startWrite();
    panel_->writeAddrWindow(source.x, source.y, source.width, source.height);
    const auto* bytes = reinterpret_cast<const uint8_t*>(source.pixels);
    const size_t count = static_cast<size_t>(source.width) * source.height * sizeof(uint16_t);
    const int64_t started = esp_timer_get_time();
    for (size_t offset = 0; offset < count; offset += transferBytes_) {
      const size_t batch = std::min(transferBytes_, count - offset);
      std::memcpy(transferBuffer_, bytes + offset, batch);
      bus_->writeBytes(transferBuffer_, batch);
    }
    panel_->endWrite();
    writeUs_ = esp_timer_get_time() - started;
    return true;
  }

  const ScreenTransform transform(kDisplaySize, angle());
  const size_t capacity = dma_.bufferBytes() / sizeof(uint16_t);
  const int rowsPerBatch = static_cast<int>(std::min(
      capacity / kDisplaySize, static_cast<size_t>(kDisplaySize)));
  panel_->startWrite();
  panel_->writeAddrWindow(0, 0, kDisplaySize, kDisplaySize);
  panel_->endWrite();
  if (!dma_.start()) {
    error_ = dma_.error();
    return false;
  }
  for (int y = 0; y < kDisplaySize; y += rowsPerBatch) {
    const int rows = std::min(rowsPerBatch, kDisplaySize - y);
    const int64_t waiting = esp_timer_get_time();
    auto* output = reinterpret_cast<uint16_t*>(dma_.acquire());
    writeUs_ += esp_timer_get_time() - waiting;
    if (!output) break;
    const int64_t started = esp_timer_get_time();
    if (!transform.renderRows(source, y, rows, output, capacity)) {
      error_ = "Display scanout failed.";
      break;
    }
    const int64_t composed = esp_timer_get_time();
    composeUs_ += composed - started;
    if (!dma_.submit(rows * kDisplaySize * sizeof(uint16_t))) break;
    writeUs_ += esp_timer_get_time() - composed;
  }
  const int64_t waiting = esp_timer_get_time();
  const bool completed = dma_.finish();
  writeUs_ += esp_timer_get_time() - waiting;
  if (!completed && !error_) error_ = dma_.error();
  return error_ == nullptr;
}
}
