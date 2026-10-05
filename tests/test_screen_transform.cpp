#include "../firmware/AgentCompanion/src/ScreenOrientation.h"
#include <array>
#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>

namespace {
uint16_t swap(uint16_t pixel) {
  return static_cast<uint16_t>((pixel >> 8) | (pixel << 8));
}

void check(int size, float angle, int x, int y, int width, int height,
           copilot::Rgb565Order order) {
  std::vector<uint16_t> pixels(width * height);
  for (size_t index = 0; index < pixels.size(); ++index) {
    const uint16_t color = static_cast<uint16_t>(index + 1);
    pixels[index] = order == copilot::Rgb565Order::Display ? swap(color) : color;
  }
  const copilot::ScreenPixels source{pixels.data(), x, y, width, height, order};
  const copilot::ScreenTransform transform(size, angle);
  std::vector<uint16_t> output(size * size, 0xffff);
  for (int row = 0; row < size; row += 4) {
    const int rows = std::min(4, size - row);
    assert(transform.renderRows(source, row, rows, output.data() + row * size, size * rows));
  }
  for (int panelY = 0; panelY < size; ++panelY) {
    for (int panelX = 0; panelX < size; ++panelX) {
      int16_t contentX, contentY;
      uint16_t expected = 0;
      if (transform.panelToContent(panelX, panelY, contentX, contentY)
          && contentX >= x && contentX < x + width
          && contentY >= y && contentY < y + height)
        expected = swap(static_cast<uint16_t>((contentY - y) * width + contentX - x + 1));
      assert(output[panelY * size + panelX] == expected);
    }
  }
  if (angle == 0.0f) {
    for (int row = 0; row < height; ++row)
      for (int column = 0; column < width; ++column)
        assert(output[(row + y) * size + column + x] == swap(row * width + column + 1));
  } else if (angle == copilot::kOrientationPi / 2) {
    for (int row = 0; row < size; ++row)
      for (int column = 0; column < size; ++column) {
        const int sx = row - x, sy = size - 1 - column - y;
        const uint16_t expected = sx >= 0 && sy >= 0 && sx < width && sy < height
            ? swap(sy * width + sx + 1) : 0;
        assert(output[row * size + column] == expected);
      }
  }
}
}

int main() {
  for (auto order : {copilot::Rgb565Order::Native, copilot::Rgb565Order::Display}) {
    for (float angle : {0.0f, copilot::kOrientationPi / 2, copilot::kOrientationPi,
                        -copilot::kOrientationPi / 2, copilot::kOrientationPi / 4, -0.37f}) {
      check(5, angle, 0, 0, 5, 5, order);
      check(6, angle, 1, 1, 4, 4, order);
      check(466, angle, 27, 0, 412, 466, order);
    }
    for (int degrees = -180; degrees <= 180; degrees += 5) {
      const float angle = degrees * copilot::kOrientationPi / 180;
      check(5, angle, 1, 1, 3, 3, order);
      check(6, angle, 0, 0, 6, 6, order);
    }
  }

  const std::array<uint16_t, 4> colors{0xf800, 0x07e0, 0x001f, 0xffff};
  std::array<uint16_t, 4> output{};
  const copilot::ScreenPixels source{colors.data(), 0, 0, 2, 2, copilot::Rgb565Order::Native};
  const copilot::ScreenTransform upright(2, 0);
  assert(upright.renderRows(source, 0, 2, output.data(), output.size()));
  const auto* bytes = reinterpret_cast<const uint8_t*>(output.data());
  assert(bytes[0] == 0xf8 && bytes[1] == 0x00);
  assert(bytes[2] == 0x07 && bytes[3] == 0xe0);
  assert(bytes[4] == 0x00 && bytes[5] == 0x1f);

  assert(!upright.renderRows(source, 0, 2, output.data(), 3));
  assert(!upright.renderRows(source, 1, 2, output.data(), output.size()));
  assert(!upright.renderRows({nullptr, 0, 0, 2, 2, copilot::Rgb565Order::Native},
                             0, 2, output.data(), output.size()));
  assert(!upright.renderRows({colors.data(), 1, 0, 2, 2, copilot::Rgb565Order::Native},
                             0, 2, output.data(), output.size()));
  int16_t x, y;
  assert(!upright.panelToContent(-1, 0, x, y));
  assert(!upright.panelToContent(2, 0, x, y));
  assert(!copilot::ScreenTransform(0, 0).panelToContent(0, 0, x, y));
  std::cout << "PASS: full-resolution rotation, centered frames, native/display colors and matching touch\n";
}
