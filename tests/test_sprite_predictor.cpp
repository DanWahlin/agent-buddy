#include "../tools/HostSpriteInflate.h"
#include <algorithm>
#include <cassert>
#include <iostream>
#include <vector>

using copilot::SpritePredictor;

static void check(size_t width, size_t height) {
  const size_t count = width * height;
  std::vector<uint16_t> original(count), expected(count);
  std::vector<uint8_t> filtered(count * 2);
  for (size_t i = 0; i < count; ++i) {
    original[i] = static_cast<uint16_t>(i * 977 + (i / width) * 3571);
    expected[i] = __builtin_bswap16(original[i]);
    const unsigned above = i >= width ? original[i - width] : 0;
    const uint16_t delta = static_cast<uint16_t>(original[i] - above);
    filtered[i * 2] = delta >> 8;
    filtered[i * 2 + 1] = delta & 255;
  }
  std::vector<uint16_t> guarded(count + 2, 0xa55a);
  auto* output = reinterpret_cast<uint8_t*>(guarded.data() + 1);
  SpritePredictor predictor;
  for (size_t chunk : {2u, 46u, 32768u}) {
    assert(predictor.reset(output, filtered.size(), width));
    assert(!predictor.complete());
    for (size_t offset = 0; offset < filtered.size(); offset += chunk)
      assert(predictor.consume(filtered.data() + offset, std::min(chunk, filtered.size() - offset)));
    assert(predictor.complete());
    assert(std::equal(expected.begin(), expected.end(), guarded.begin() + 1));
    assert(guarded.front() == 0xa55a && guarded.back() == 0xa55a);
    assert(!predictor.consume(filtered.data(), 2));
  }
  std::vector<uint8_t> compressed(compressBound(filtered.size()));
  uLongf size = compressed.size();
  assert(compress2(compressed.data(), &size, filtered.data(), filtered.size(), 9) == Z_OK);
  compressed.resize(size);
  assert(inflateSpriteHost(output, filtered.size(), compressed.data(), size, width, width));
  assert(std::equal(expected.begin(), expected.end(), guarded.begin() + 1));
  const size_t stride = std::min<size_t>(copilot::kCharacterFrameWidth, width + 8);
  std::vector<uint16_t> strided(stride * height + 2, 0xa55a);
  auto* spaced = reinterpret_cast<uint8_t*>(strided.data() + 1);
  assert(inflateSpriteHost(spaced, filtered.size(), compressed.data(), size, width, stride));
  for (size_t y = 0; y < height; ++y) {
    assert(std::equal(expected.begin() + y * width, expected.begin() + (y + 1) * width,
                      strided.begin() + 1 + y * stride));
    for (size_t x = width; x < stride; ++x) assert(strided[1 + y * stride + x] == 0xa55a);
  }
  assert(strided.front() == 0xa55a && strided.back() == 0xa55a);
  assert(!inflateSpriteHost(output, filtered.size(), compressed.data(), size - 1, width, width));
  compressed.push_back(0);
  assert(!inflateSpriteHost(output, filtered.size(), compressed.data(), compressed.size(), width, width));
  compressed[compressed.size() / 2] ^= 0xff;
  assert(!inflateSpriteHost(output, filtered.size(), compressed.data(), size, width, width));
  assert(!predictor.reset(output, filtered.size(), 0));
  assert(!predictor.reset(output, filtered.size(), copilot::kCharacterFrameWidth + 1));
  assert(!predictor.reset(output, filtered.size(), width, copilot::kCharacterFrameWidth + 1));
  assert(!predictor.reset(output + 1, filtered.size(), width));
  assert(!predictor.reset(output, filtered.size() - 1, width));
  assert(!predictor.consume(filtered.data(), 2));
  assert(!predictor.complete());
  assert(predictor.reset(output, filtered.size(), width));
  assert(!predictor.consume(filtered.data(), 1));
  assert(!predictor.consume(filtered.data(), filtered.size() + 2));
  std::fill(filtered.begin(), filtered.end(), 0);
  assert(predictor.reset(output, filtered.size(), width));
  assert(predictor.consume(filtered.data(), filtered.size()) && predictor.complete());
  assert(std::all_of(guarded.begin() + 1, guarded.end() - 1, [](uint16_t x) { return x == 0; }));
  assert(guarded.front() == 0xa55a && guarded.back() == 0xa55a);
}

// skipUnchanged writes only pixels that differ and reports each row's changed columns.
static void skipUnchanged(size_t width, size_t height, size_t stride) {
  const size_t count = width * height;
  std::vector<uint16_t> first(count), second(count);
  for (size_t i = 0; i < count; ++i) first[i] = second[i] = static_cast<uint16_t>(i * 977 + 13);
  // Rows 1 and 5 change in a few columns; row 3 changes at both ends.
  const std::vector<std::pair<size_t, size_t>> changes = {{1, width / 2}, {5, 0}, {3, 0}, {3, width - 1}};
  for (const auto& change : changes) second[change.first * width + change.second] ^= 0x0101;
  auto encode = [&](const std::vector<uint16_t>& pixels) {
    std::vector<uint8_t> filtered(count * 2);
    for (size_t i = 0; i < count; ++i) {
      const uint16_t original = __builtin_bswap16(pixels[i]);
      const uint16_t above = i >= width ? __builtin_bswap16(pixels[i - width]) : 0;
      const uint16_t delta = static_cast<uint16_t>(original - above);
      filtered[i * 2] = delta >> 8;
      filtered[i * 2 + 1] = delta & 255;
    }
    return filtered;
  };
  std::vector<uint16_t> output(stride * height + 2, 0xa55a);
  auto* bytes = reinterpret_cast<uint8_t*>(output.data() + 1);
  SpritePredictor predictor;
  std::vector<copilot::SpriteRowChange> rows(height + 1, {7, 7});
  for (const auto* pixels : {&first, &second}) {
    const auto filtered = encode(*pixels);
    assert(predictor.reset(bytes, filtered.size(), width, stride, rows.data()));
    for (size_t offset = 0; offset < filtered.size(); offset += 46)
      assert(predictor.consume(filtered.data() + offset, std::min<size_t>(46, filtered.size() - offset)));
    assert(predictor.complete());
    for (size_t y = 0; y < height; ++y)
      for (size_t x = 0; x < width; ++x) assert(output[1 + y * stride + x] == (*pixels)[y * width + x]);
    assert(output.front() == 0xa55a && output.back() == 0xa55a);
  }
  for (size_t y = 0; y < height; ++y) {
    const size_t begin = rows[y].begin, end = rows[y].end;
    if (y == 1) assert(begin == width / 2 && end == width / 2 + 1);
    else if (y == 3) assert(begin == 0 && end == width);
    else if (y == 5) assert(begin == 0 && end == 1);
    else assert(begin >= end);
  }
  // Only the output's rows are reported.
  assert(rows[height].begin == 7 && rows[height].end == 7);
}

int main() {
  for (size_t width : {1u, 2u, 21u, 39u, 412u}) check(width, 352);
  skipUnchanged(277, 9, 412);
  skipUnchanged(412, 7, 412);
  std::cout << "PASS: word prediction, row/ring boundaries, uint16 wrap, reset, guards, corrupt streams and "
               "unchanged rows\n";
}
