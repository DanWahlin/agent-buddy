#include "../firmware/AgentCompanion/src/OrientedDisplay.h"
#include <array>
#include <cassert>
#include <cstring>
#include <iostream>
#include <vector>

int main() {
  using namespace copilot;
  Arduino_DataBus bus;
  Arduino_CO5300 panel;
  OrientedDisplay display(&panel, &bus);
  assert(display.begin());
  alignas(16) std::array<uint8_t, 4096> dma{};
  bus.dmaBuffer = dma.data();
  bus.dmaBytes = dma.size();
  assert(!display.setTransferBuffer(dma.data(), 2));
  assert(display.error());
  assert(!display.setTransferBuffer(dma.data() + 1, dma.size() - 2));
  assert(display.setTransferBuffer(dma.data(), dma.size()));
  assert(!display.error());

  std::vector<uint16_t> character(kCharacterFrameWidth * kCharacterFrameHeight);
  for (size_t index = 0; index < character.size(); ++index)
    character[index] = static_cast<uint16_t>(index + 1);
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  assert(bus.bytes.size() == character.size() * sizeof(uint16_t));
  assert(std::memcmp(bus.bytes.data(), character.data(), bus.bytes.size()) == 0);
  assert(panel.window.x == kCharacterFrameX && panel.window.width == kCharacterFrameWidth);
  assert(panel.marginClears == 2 && !panel.started);
  bus.bytes.clear();
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  assert(panel.marginClears == 2);

  display.fillScreen(0xf800);
  bus.bytes.clear();
  display.flush();
  assert(!display.error() && !panel.started);
  assert(bus.bytes.size() == kDisplaySize * kDisplaySize * sizeof(uint16_t));
  for (size_t byte = 0; byte < bus.bytes.size(); byte += 2)
    assert(bus.bytes[byte] == 0xf8 && bus.bytes[byte + 1] == 0x00);
  bus.bytes.clear();
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  assert(panel.marginClears == 4);

  for (float angle : {kOrientationPi / 2, kOrientationPi, -kOrientationPi / 2, 0.61f}) {
    assert(display.setAngle(angle));
    std::vector<uint16_t> expected(kDisplaySize * kDisplaySize);
    const ScreenPixels source{character.data(), kCharacterFrameX, 0,
                              kCharacterFrameWidth, kCharacterFrameHeight, Rgb565Order::Display};
    assert(ScreenTransform(kDisplaySize, display.angle()).renderRows(
        source, 0, kDisplaySize, expected.data(), expected.size()));
    bus.bytes.clear();
    assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                              kCharacterFrameWidth, kCharacterFrameHeight));
    assert(bus.bytes.size() == expected.size() * sizeof(uint16_t));
    assert(std::memcmp(bus.bytes.data(), expected.data(), bus.bytes.size()) == 0);
    assert(panel.window.x == 0 && panel.window.width == kDisplaySize && !panel.started);
  }
  assert(display.setAngle(0));
  bus.bytes.clear();
  assert(display.flushFrame(character.data(), kCharacterFrameX, 0,
                            kCharacterFrameWidth, kCharacterFrameHeight));
  assert(panel.marginClears == 6);
  assert(!display.flushFrame(nullptr, 0, 0, kDisplaySize, kDisplaySize));
  assert(display.error() && !panel.started);
  assert(!display.flushFrame(character.data(), kDisplaySize - 1, 0, 2, 1));
  assert(display.error());

  OrientedDisplay uninitialized(&panel, &bus);
  assert(uninitialized.begin());
  uninitialized.flush();
  assert(uninitialized.error() && !panel.started);
  std::cout << "PASS: production display scanout, DMA-only writes, menu colors and upright margin recovery\n";
}
