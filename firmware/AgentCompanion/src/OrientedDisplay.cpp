#include "OrientedDisplay.h"
#include <algorithm>
#include <cstring>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <esp_memory_utils.h>

namespace copilot {
OrientedDisplay::OrientedDisplay(board::DisplayPanel* panel, Arduino_DataBus* bus,
                                 const DisplayScanout& scanout, void (*setBrightness)(uint8_t))
    : Arduino_Canvas(kDisplaySize, kDisplaySize, nullptr), panel_(panel), bus_(bus),
      setBrightness_(setBrightness), dma_(scanout) {}

bool OrientedDisplay::begin(int32_t speed) {
  error_ = nullptr;
  if (!panel_->begin(speed)) {
    error_ = "Display panel initialization failed.";
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
      || !esp_ptr_dma_capable(buffer) || bytes < 2 * kPanelWidth * sizeof(uint16_t)
      || bytes % (2 * alignof(uint32_t))) {
    error_ = "Invalid display transfer buffer.";
    return false;
  }
  transferBuffer_ = buffer;
  transferBytes_ = bytes;
  dma_.setBuffer(buffer, bytes);
  return true;
}

bool OrientedDisplay::setAngle(float radians) {
  if (!orientation_.update(radians)) return false;
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

  // Upright character frames keep the original direct, DMA-staged transfer when the panel shows
  // content at full size; a panel narrower or shorter than the content gets the part that it shows.
  // A panel that shows the content smaller always scales through the transform below.
  if (kShownContentSize == kDisplaySize && angle() == 0.0f && source.order == Rgb565Order::Display) {
    // The source's area on the panel, clipped to it.
    const int left = std::max(source.x + kPanelContentX, 0);
    const int top = std::max(source.y + kPanelContentY, 0);
    const int right = std::min(source.x + source.width + kPanelContentX, kPanelWidth);
    const int bottom = std::min(source.y + source.height + kPanelContentY, kPanelHeight);
    const bool shown = left < right && top < bottom;
    if (frameMarginsDirty_) {
      if (shown) {
        panel_->fillRect(0, 0, kPanelWidth, top, 0);
        panel_->fillRect(0, bottom, kPanelWidth, kPanelHeight - bottom, 0);
        panel_->fillRect(0, top, left, bottom - top, 0);
        panel_->fillRect(right, top, kPanelWidth - right, bottom - top, 0);
      } else {
        panel_->fillRect(0, 0, kPanelWidth, kPanelHeight, 0);
      }
      frameMarginsDirty_ = false;
    }
    if (!shown) return true;
    const int width = right - left;
    const uint16_t* first = source.pixels + (top - kPanelContentY - source.y) * source.width
                            + (left - kPanelContentX - source.x);
    panel_->startWrite();
    panel_->writeAddrWindow(left, top, width, bottom - top);
    const int64_t started = esp_timer_get_time();
    if (width == source.width) {
      // Whole source rows: one run of pixels.
      const auto* bytes = reinterpret_cast<const uint8_t*>(first);
      const size_t count = static_cast<size_t>(width) * (bottom - top) * sizeof(uint16_t);
      for (size_t offset = 0; offset < count; offset += transferBytes_) {
        const size_t batch = std::min(transferBytes_, count - offset);
        std::memcpy(transferBuffer_, bytes + offset, batch);
        bus_->writeBytes(transferBuffer_, batch);
      }
    } else {
      // The middle of each source row.
      const size_t rowBytes = static_cast<size_t>(width) * sizeof(uint16_t);
      const int rowsPerBatch = static_cast<int>(transferBytes_ / rowBytes);
      for (int row = top; row < bottom; row += rowsPerBatch) {
        const int rows = std::min(rowsPerBatch, bottom - row);
        for (int index = 0; index < rows; ++index)
          std::memcpy(transferBuffer_ + index * rowBytes,
                      first + static_cast<size_t>(row - top + index) * source.width, rowBytes);
        bus_->writeBytes(transferBuffer_, rows * rowBytes);
      }
    }
    panel_->endWrite();
    writeUs_ = esp_timer_get_time() - started;
    return true;
  }

  const ScreenTransform transform(kPanelWidth, kPanelHeight, kDisplaySize, kShownContentSize, angle());
  const size_t capacity = dma_.bufferBytes() / sizeof(uint16_t);
  const int rowsPerBatch = static_cast<int>(std::min(
      capacity / kPanelWidth, static_cast<size_t>(kPanelHeight)));
  panel_->startWrite();
  panel_->writeAddrWindow(0, 0, kPanelWidth, kPanelHeight);
  panel_->endWrite();
  if (!dma_.start()) {
    error_ = dma_.error();
    return false;
  }
  for (int y = 0; y < kPanelHeight; y += rowsPerBatch) {
    const int rows = std::min(rowsPerBatch, kPanelHeight - y);
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
    if (!dma_.submit(rows * kPanelWidth * sizeof(uint16_t))) break;
    writeUs_ += esp_timer_get_time() - composed;
  }
  const int64_t waiting = esp_timer_get_time();
  const bool completed = dma_.finish();
  writeUs_ += esp_timer_get_time() - waiting;
  if (!completed && !error_) error_ = dma_.error();
  return error_ == nullptr;
}
}
