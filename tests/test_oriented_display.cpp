#include "../firmware/AgentCompanion/src/OrientedDisplay.h"
#include <algorithm>
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
  std::vector<uint16_t> expected(kPanelWidth * kPanelHeight);
  assert(ScreenTransform(kPanelWidth, kPanelHeight, kDisplaySize, kShownContentSize, angle)
             .renderRows(source, 0, kPanelHeight, expected.data(), expected.size()));
  return expected;
}
}

int main() {
  using namespace copilot;
  // A panel that shows the content smaller always scales, so it never takes the upright direct
  // transfer.
  constexpr bool fullSize = kShownContentSize == kDisplaySize;
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
  assert(!display.setTransferBuffer(dma.data(), kPanelWidth * sizeof(uint16_t)));
  assert(display.error());
  assert(!display.setTransferBuffer(dma.data() + 1, dma.size() - 2));
  assert(display.setTransferBuffer(dma.data(), dma.size()));
  assert(!display.error());

  std::vector<uint16_t> character(kCharacterFrameWidth * kCharacterFrameHeight);
  for (size_t index = 0; index < character.size(); ++index)
    character[index] = static_cast<uint16_t>(index + 1);
  const ScreenPixels characterSource{character.data(), kCharacterFrameX, 0, kCharacterFrameWidth,
                                     kCharacterFrameHeight, Rgb565Order::Display};
  // At full size, the panel shows the part of the frame that is on it, and black margins around it.
  const int left = std::max(kCharacterFrameX + kPanelContentX, 0);
  const int top = std::max(kPanelContentY, 0);
  const int right = std::min(kCharacterFrameX + kCharacterFrameWidth + kPanelContentX, kPanelWidth);
  const int bottom = std::min(kCharacterFrameHeight + kPanelContentY, kPanelHeight);
  const unsigned margins = (top > 0) + (bottom < kPanelHeight) + (left > 0) + (right < kPanelWidth);
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  if (fullSize) {
    std::vector<uint16_t> shown;
    for (int y = top; y < bottom; ++y)
      for (int x = left; x < right; ++x)
        shown.push_back(character[(y - kPanelContentY) * kCharacterFrameWidth
                                  + (x - kPanelContentX - kCharacterFrameX)]);
    assert(bus.bytes.size() == shown.size() * sizeof(uint16_t));
    assert(std::memcmp(bus.bytes.data(), shown.data(), bus.bytes.size()) == 0);
    assert(panel.window.x == left && panel.window.y == top);
    assert(panel.window.width == right - left && panel.window.height == bottom - top);
    assert(panel.marginClears == margins && margins > 0 && !panel.started);
    // The direct transfer agrees with the transform that rotated frames and touch use.
    const std::vector<uint16_t> transformed = scanout(characterSource, 0);
    for (int y = top; y < bottom; ++y)
      assert(std::memcmp(&transformed[y * kPanelWidth + left], &shown[(y - top) * (right - left)],
                         (right - left) * sizeof(uint16_t)) == 0);
  } else {
    const std::vector<uint16_t> expected = scanout(characterSource, 0);
    assert(bus.bytes.size() == expected.size() * sizeof(uint16_t));
    assert(std::memcmp(bus.bytes.data(), expected.data(), bus.bytes.size()) == 0);
    assert(panel.window.x == 0 && panel.window.y == 0);
    assert(panel.window.width == kPanelWidth && panel.window.height == kPanelHeight);
    assert(panel.marginClears == 0 && !panel.started);
  }
  bus.bytes.clear();
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  if (fullSize) assert(panel.marginClears == margins);

  display.fillScreen(0xf800);
  bus.bytes.clear();
  display.flush();
  assert(!display.error() && !panel.started);
  assert(spi_stub::maxPending == 2 && spi_stub::owner == nullptr);
  assert(bus.bytes.size() == kPanelWidth * kPanelHeight * sizeof(uint16_t));
  // Red where the panel shows the content, in display byte order, and black around it.
  const int shownX = (kPanelWidth - kShownContentSize) / 2;
  const int shownY = (kPanelHeight - kShownContentSize) / 2;
  for (int y = 0; y < kPanelHeight; ++y) {
    for (int x = 0; x < kPanelWidth; ++x) {
      const size_t byte = (static_cast<size_t>(y) * kPanelWidth + x) * sizeof(uint16_t);
      const bool red = x >= shownX && x < shownX + kShownContentSize
                       && y >= shownY && y < shownY + kShownContentSize;
      assert(bus.bytes[byte] == (red ? 0xf8 : 0x00) && bus.bytes[byte + 1] == 0x00);
    }
  }
  bus.bytes.clear();
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  if (fullSize) assert(panel.marginClears == 2 * margins);

  for (float angle : {kOrientationPi / 2, kOrientationPi, -kOrientationPi / 2, 0.61f}) {
    assert(display.setAngle(angle));
    const std::vector<uint16_t> expected = scanout(characterSource, display.angle());
    bus.bytes.clear();
    assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                              kCharacterFrameWidth, kCharacterFrameHeight));
    assert(bus.bytes.size() == expected.size() * sizeof(uint16_t));
    assert(std::memcmp(bus.bytes.data(), expected.data(), bus.bytes.size()) == 0);
    assert(panel.window.x == 0 && panel.window.y == 0 && panel.window.width == kPanelWidth
           && panel.window.height == kPanelHeight && !panel.started);
  }
  assert(display.setAngle(0));
  bus.bytes.clear();
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  if (fullSize) assert(panel.marginClears == 3 * margins);
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
