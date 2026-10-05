#pragma once
#include <cstddef>
#include <cstdint>
#include <driver/spi_master.h>

namespace copilot {
class DisplayDma {
 public:
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
  spi_device_handle_t device_ = nullptr;
  spi_transaction_ext_t transactions_[2]{};
  uint8_t* buffer_ = nullptr;
  size_t bufferBytes_ = 0;
  unsigned next_ = 0, pending_ = 0;
  bool active_ = false, first_ = true;
  const char* error_ = nullptr;
};
}
