#pragma once
#include <algorithm>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <vector>

constexpr int32_t GFX_NOT_DEFINED = -1;
#define ESP32QSPI_SPI_HOST SPI2_HOST
#define log_e(...) std::fprintf(stderr, __VA_ARGS__)

class Arduino_DataBus {
 public:
  uint8_t* dmaBuffer = nullptr;
  size_t dmaBytes = 0;
  std::vector<uint8_t> bytes;
  void writeBytes(uint8_t* data, size_t count) {
    assert(data == dmaBuffer && count <= dmaBytes);
    bytes.insert(bytes.end(), data, data + count);
  }
};

class Arduino_CO5300 {
 public:
  struct Rect { int x, y, width, height; };
  bool started = false;
  unsigned marginClears = 0;
  Rect window{};
  bool begin(int32_t) { return true; }
  void startWrite() { assert(!started); started = true; }
  void endWrite() { assert(started); started = false; }
  void writeAddrWindow(int x, int y, int width, int height) {
    assert(started);
    window = {x, y, width, height};
  }
  void fillRect(int, int, int width, int height, uint16_t color) {
    assert(!started && color == 0);
    if (width > 0 && height > 0) ++marginClears;
  }
  void setBrightness(uint8_t) {}
};

class Arduino_Canvas {
 public:
  Arduino_Canvas(int width, int height, void*) : pixels_(width * height) {}
  virtual ~Arduino_Canvas() { std::free(_framebuffer); }
  virtual bool begin(int32_t = GFX_NOT_DEFINED) { return true; }
  virtual void flush(bool = false) {}
  void fillScreen(uint16_t color) {
    std::fill(_framebuffer, _framebuffer + pixels_, color);
  }
  uint16_t* getFramebuffer() { return _framebuffer; }

 protected:
  uint16_t* _framebuffer = nullptr;

 private:
  size_t pixels_;
};
