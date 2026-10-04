#pragma once
#include "Config.h"
#include <Arduino_GFX_Library.h>
#include <cstddef>
#include <cstdint>

namespace copilot {
class OrientedDisplay : public Arduino_Canvas {
 public:
  OrientedDisplay(Arduino_CO5300* panel, Arduino_DataBus* bus);
  ~OrientedDisplay();
  bool begin(int32_t speed = GFX_NOT_DEFINED) override;
  void flush(bool forceFlush = false) override;
  void flushFrame(const uint16_t* pixels, int x, int y, int width, int height);
  void setAngle(float angle) { angle_ = angle; }
  void setTransferBuffer(uint8_t* buffer, size_t bytes) {
    transferBuffer_ = buffer;
    transferBytes_ = bytes;
  }
  void setBrightness(uint8_t brightness) { panel_->setBrightness(brightness); }

 private:
  void flushSource(const uint16_t* pixels, int x, int y, int width, int height);
  Arduino_CO5300* panel_;
  Arduino_DataBus* bus_;
  uint16_t* rotatedFramebuffer_ = nullptr;
  uint8_t* transferBuffer_ = nullptr;
  size_t transferBytes_ = 0;
  float angle_ = 0.0f;
  bool snappedUpright_ = true;
};
}
