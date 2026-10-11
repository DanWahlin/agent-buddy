#pragma once
#include <cstdint>

namespace copilot {
enum class SettingsAction : uint8_t {
  None,
  BrightnessDown,
  BrightnessUp,
  SoundDown,
  SoundUp,
  Wifi,
  WifiSetup,
  Back,
  Idle,
  Surprise,
  Working,
  Complete,
  Attention,
  Close
};

struct SettingsRect {
  int x, y, width, height;
  constexpr bool contains(int16_t px, int16_t py) const {
    return px >= x && px < x + width && py >= y && py < y + height;
  }
};

// The one settings layout: AgentCompanion.ino draws these rectangles and tap() tests them.
namespace settings_layout {
constexpr SettingsRect kWifiStatus{113, 36, 240, 52};
constexpr SettingsRect kBrightnessDown{150, 116, 48, 38};
constexpr SettingsRect kBrightnessUp{268, 116, 48, 38};
constexpr SettingsRect kVolumeDown{150, 180, 48, 38};
constexpr SettingsRect kVolumeUp{268, 180, 48, 38};
constexpr SettingsRect kWifiSetup{88, 336, 290, 44};
constexpr SettingsRect kBack{150, 394, 166, 38};

struct LabeledButton {
  SettingsRect rect;
  SettingsAction action;
  const char* label;
  uint8_t textSize;
};
constexpr LabeledButton kModeButtons[] = {
  {{58, 306, 165, 34}, SettingsAction::Idle, "Idle", 2},
  {{243, 306, 165, 34}, SettingsAction::Working, "Working", 2},
  {{58, 344, 165, 34}, SettingsAction::Complete, "Complete", 2},
  {{243, 344, 165, 34}, SettingsAction::Attention, "Needs attention", 1},
  {{58, 382, 165, 34}, SettingsAction::Surprise, "Surprise", 2},
  {{243, 382, 165, 34}, SettingsAction::Close, "Close", 2},
};
}

class SettingsMenu {
 public:
  explicit SettingsMenu(uint8_t brightness, uint8_t soundVolume = 50)
      : brightness_(brightness), soundVolume_(soundVolume) {}

  bool isOpen() const { return open_; }
  bool networkPage() const { return networkPage_; }
  void open() { open_ = true; networkPage_ = false; }
  void close() { open_ = false; networkPage_ = false; }
  void openNetwork() { networkPage_ = true; }
  void back() { networkPage_ = false; }
  uint8_t brightness() const { return brightness_; }
  uint8_t soundVolume() const { return soundVolume_; }
  void setSoundVolume(uint8_t volume) { soundVolume_ = volume > 100 ? 100 : volume; }

  SettingsAction tap(int16_t x, int16_t y) {
    using namespace settings_layout;
    if (!open_) return SettingsAction::None;
    if (networkPage_) {
      if (kWifiSetup.contains(x, y)) return SettingsAction::WifiSetup;
      if (kBack.contains(x, y)) return SettingsAction::Back;
      return SettingsAction::None;
    }
    if (kWifiStatus.contains(x, y)) return SettingsAction::Wifi;
    if (kBrightnessDown.contains(x, y)) {
      brightness_ = brightness_ > 55 ? brightness_ - 25 : 30;
      return SettingsAction::BrightnessDown;
    }
    if (kBrightnessUp.contains(x, y)) {
      brightness_ = brightness_ < 230 ? brightness_ + 25 : 255;
      return SettingsAction::BrightnessUp;
    }
    if (kVolumeDown.contains(x, y)) {
      soundVolume_ = soundVolume_ > 25 ? soundVolume_ - 25 : 0;
      return SettingsAction::SoundDown;
    }
    if (kVolumeUp.contains(x, y)) {
      soundVolume_ = soundVolume_ < 75 ? soundVolume_ + 25 : 100;
      return SettingsAction::SoundUp;
    }
    for (const LabeledButton& button : kModeButtons)
      if (button.rect.contains(x, y)) return button.action;
    return SettingsAction::None;
  }

 private:
  uint8_t brightness_;
  uint8_t soundVolume_;
  bool open_ = false;
  bool networkPage_ = false;
};
}
