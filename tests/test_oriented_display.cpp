#include "../firmware/AgentCompanion/src/OrientedDisplay.h"
#include <array>
#include <cassert>
#include <cstring>
#include <iostream>
#include <vector>

namespace {
uint8_t brightness = 0;
void setBrightness(uint8_t value) { brightness = value; }

// The board's scanout, as its BoardDrivers.h gives it.
#if defined(AGENT_BOARD_WAVESHARE_LCD_154)
const copilot::DisplayScanout kScanout{SPI2_HOST, 3, 0, 0, false, 0, 0, copilot::kDisplayCsPin,
                                       copilot::kDisplayDcPin};
#else
const copilot::DisplayScanout kScanout{SPI2_HOST, 0, 8, 24, true, copilot::kDisplayQspiWriteCommand,
                                       copilot::kDisplayQspiPixelAddress, copilot::kDisplayCsPin, -1};
#endif

void expectScanout() {
  spi_stub::host = kScanout.host;
  spi_stub::mode = kScanout.mode;
  spi_stub::commandBits = kScanout.commandBits;
  spi_stub::addressBits = kScanout.addressBits;
  spi_stub::quad = kScanout.quadData;
  spi_stub::command = kScanout.command;
  spi_stub::address = kScanout.address;
  spi_stub::csPin = kScanout.csPin;
  spi_stub::dcPin = kScanout.dcPin;
}

// What the panel receives for a source: the content scaled and rotated to the panel.
std::vector<uint16_t> scanout(const copilot::ScreenPixels& source, float angle) {
  using namespace copilot;
  std::vector<uint16_t> expected(kPanelSize * kPanelSize);
  assert(ScreenTransform(kPanelSize, kDisplaySize, angle)
             .renderRows(source, 0, kPanelSize, expected.data(), expected.size()));
  return expected;
}
}

int main() {
  using namespace copilot;
  // A panel smaller than the content always scales, so it never takes the upright direct transfer.
  constexpr bool fullSize = kPanelSize == kDisplaySize;
  expectScanout();
  Arduino_DataBus bus;
  spi_stub::sink = &bus;
  board::DisplayPanel panel;
  OrientedDisplay display(&panel, &bus, kScanout, setBrightness);
  assert(display.begin());
  display.setBrightness(77);
  assert(brightness == 77);
  alignas(16) std::array<uint8_t, 4096> dma{};
  bus.dmaBuffer = dma.data();
  bus.dmaBytes = dma.size();
  assert(!display.setTransferBuffer(dma.data(), 2));
  assert(!display.setTransferBuffer(dma.data(), kPanelSize * sizeof(uint16_t)));
  assert(display.error());
  assert(!display.setTransferBuffer(dma.data() + 1, dma.size() - 2));
  assert(display.setTransferBuffer(dma.data(), dma.size()));
  assert(!display.error());

  std::vector<uint16_t> character(kCharacterFrameWidth * kCharacterFrameHeight);
  for (size_t index = 0; index < character.size(); ++index)
    character[index] = static_cast<uint16_t>(index + 1);
  const ScreenPixels characterSource{character.data(), kCharacterFrameX, 0, kCharacterFrameWidth,
                                     kCharacterFrameHeight, Rgb565Order::Display};
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  if (fullSize) {
    assert(bus.bytes.size() == character.size() * sizeof(uint16_t));
    assert(std::memcmp(bus.bytes.data(), character.data(), bus.bytes.size()) == 0);
    assert(panel.window.x == kCharacterFrameX && panel.window.width == kCharacterFrameWidth);
    assert(panel.marginClears == 2 && !panel.started);
  } else {
    const std::vector<uint16_t> expected = scanout(characterSource, 0);
    assert(bus.bytes.size() == expected.size() * sizeof(uint16_t));
    assert(std::memcmp(bus.bytes.data(), expected.data(), bus.bytes.size()) == 0);
    assert(panel.window.x == 0 && panel.window.y == 0);
    assert(panel.window.width == kPanelSize && panel.window.height == kPanelSize);
    assert(panel.marginClears == 0 && !panel.started);
  }
  bus.bytes.clear();
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  if (fullSize) assert(panel.marginClears == 2);

  display.fillScreen(0xf800);
  bus.bytes.clear();
  display.flush();
  assert(!display.error() && !panel.started);
  assert(spi_stub::maxPending == 2 && spi_stub::owner == nullptr);
  assert(bus.bytes.size() == kPanelSize * kPanelSize * sizeof(uint16_t));
  for (size_t byte = 0; byte < bus.bytes.size(); byte += 2)
    assert(bus.bytes[byte] == 0xf8 && bus.bytes[byte + 1] == 0x00);
  bus.bytes.clear();
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  if (fullSize) assert(panel.marginClears == 4);

  for (float angle : {kOrientationPi / 2, kOrientationPi, -kOrientationPi / 2, 0.61f}) {
    assert(display.setAngle(angle));
    const std::vector<uint16_t> expected = scanout(characterSource, display.angle());
    bus.bytes.clear();
    assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                              kCharacterFrameWidth, kCharacterFrameHeight));
    assert(bus.bytes.size() == expected.size() * sizeof(uint16_t));
    assert(std::memcmp(bus.bytes.data(), expected.data(), bus.bytes.size()) == 0);
    assert(panel.window.x == 0 && panel.window.width == kPanelSize && !panel.started);
  }
  assert(display.setAngle(0));
  bus.bytes.clear();
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  if (fullSize) assert(panel.marginClears == 6);
  assert(!display.flushFrame(nullptr, 0, 0, kDisplaySize, kDisplaySize));
  assert(display.error() && !panel.started);
  assert(!display.flushFrame(character.data(), kDisplaySize - 1, 0, 2, 1));
  assert(display.error());

  spi_stub::failSubmission = 1;
  display.flush();
  assert(display.error());
  assert(spi_stub::owner == nullptr && spi_stub::chipSelect == 1);
  bus.bytes.clear();
  display.flush();
  assert(!display.error() && spi_stub::owner == nullptr);

  OrientedDisplay uninitialized(&panel, &bus, kScanout, setBrightness);
  assert(uninitialized.begin());
  uninitialized.flush();
  assert(uninitialized.error() && !panel.started);

  alignas(16) std::array<uint8_t, 16 * 1024> largerDma{};
  bus.dmaBuffer = largerDma.data();
  assert(display.setAngle(0.61f));
  const std::vector<uint16_t> expected = scanout(characterSource, display.angle());
  for (size_t bytes : {size_t{8 * 1024}, largerDma.size()}) {
    bus.dmaBytes = bytes;
    assert(display.setTransferBuffer(largerDma.data(), bytes));
    bus.bytes.clear();
    assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                              kCharacterFrameWidth, kCharacterFrameHeight));
    assert(bus.bytes.size() == expected.size() * sizeof(uint16_t));
    assert(std::memcmp(bus.bytes.data(), expected.data(), bus.bytes.size()) == 0);
    assert(spi_stub::owner == nullptr && spi_stub::chipSelect == 1);
  }
  assert(display.setAngle(0));
  assert(display.setTrim(kOrientationPi / 360));
  assert(std::fabs(display.angle() - kOrientationPi / 360) < 0.00001f);
  assert(!display.setAngle(kOrientationPi / 180));
  assert(std::fabs(display.angle() - kOrientationPi / 360) < 0.00001f);
  assert(display.setTrim(0));
  assert(display.angle() == 0);
  std::cout << "PASS: " << board::kId
            << " display scanout, DMA-only writes, menu colors and upright margin recovery\n";
}
