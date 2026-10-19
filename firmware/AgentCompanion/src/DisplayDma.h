#pragma once
#include <cstddef>
#include <cstdint>
#include <driver/spi_master.h>

namespace copilot {
// How a board's panel takes pixel data once the panel driver has set the address window. Each
// board's BoardDrivers.h gives one from displayScanout().
struct DisplayScanout {
  int host;                // The SPI host that the panel's bus started.
  uint8_t mode;            // SPI mode.
  uint8_t commandBits;     // A pixel-write command and address sent before the first pixels,
  uint8_t addressBits;     // as a QSPI panel needs, or 0 and 0 for a plain SPI panel.
  bool quadData;           // Pixels go out on four data lines.
  uint16_t command;
  uint32_t address;
  int csPin;               // Chip select, held low by hand for the whole frame.
  int dcPin;               // Data/command, held high for pixel data, or -1 for none.
};

class DisplayDma {
 public:
  explicit DisplayDma(const DisplayScanout& scanout) : scanout_(scanout) {}
  ~DisplayDma();
  bool begin(int32_t speed);
  void setBuffer(uint8_t* buffer, size_t bytes);
  size_t bufferBytes() const { return bufferBytes_; }
  bool start();
  uint8_t* acquire();
  bool submit(size_t bytes);
  bool finish();
  const char* error() const { return error_; }

 private:
  bool wait();
  DisplayScanout scanout_;
  spi_device_handle_t device_ = nullptr;
  spi_transaction_ext_t transactions_[2]{};
  uint8_t* buffer_ = nullptr;
  size_t bufferBytes_ = 0;
  unsigned next_ = 0, pending_ = 0;
  bool active_ = false, first_ = true;
  const char* error_ = nullptr;
};
}
