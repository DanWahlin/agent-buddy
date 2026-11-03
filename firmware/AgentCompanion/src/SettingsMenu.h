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
  Close,
  States
};

struct SettingsRect {
  int x, y, width, height;
  constexpr bool contains(int16_t px, int16_t py) const {
    return px >= x && px < x + width && py >= y && py < y + height;
  }
};

struct LabeledButton {
  SettingsRect rect;
  SettingsAction action;
  const char* label;
  uint8_t textSize;
};

// The full settings layout: AgentCompanion.ino draws these rectangles and tap() tests them.
namespace settings_layout {
constexpr SettingsRect kWifiStatus{113, 36, 240, 52};
constexpr SettingsRect kBrightnessDown{150, 116, 48, 38};
constexpr SettingsRect kBrightnessUp{268, 116, 48, 38};
constexpr SettingsRect kVolumeDown{150, 180, 48, 38};
constexpr SettingsRect kVolumeUp{268, 180, 48, 38};
constexpr SettingsRect kWifiSetup{88, 336, 290, 44};
constexpr SettingsRect kBack{150, 394, 166, 38};

constexpr LabeledButton kModeButtons[] = {
  {{58, 306, 165, 34}, SettingsAction::Idle, "Idle", 2},
  {{243, 306, 165, 34}, SettingsAction::Working, "Working", 2},
  {{58, 344, 165, 34}, SettingsAction::Complete, "Complete", 2},
  {{243, 344, 165, 34}, SettingsAction::Attention, "Attention", 2},
  {{58, 382, 165, 34}, SettingsAction::Surprise, "Surprise", 2},
  {{243, 382, 165, 34}, SettingsAction::Close, "Close", 2},
};
}

// The compact layout, for a panel that shows the content at about half size (see kCompactUi). Its
// controls are about twice as large, so they spread over three pages: display and sound, Wi-Fi, and
// character state. The whole square is visible, so the controls reach the corners.
namespace compact_layout {
// The Wi-Fi status at the top of the screen shown without a character.
constexpr SettingsRect kWifiStatus{16, 16, 434, 80};
constexpr SettingsRect kBrightnessDown{16, 48, 112, 88};
constexpr SettingsRect kBrightnessUp{338, 48, 112, 88};
constexpr SettingsRect kVolumeDown{16, 180, 112, 88};
constexpr SettingsRect kVolumeUp{338, 180, 112, 88};
constexpr SettingsRect kWifi{16, 284, 209, 80};
constexpr SettingsRect kStates{241, 284, 209, 80};
constexpr SettingsRect kClose{16, 376, 434, 80};
// The Wi-Fi page.
constexpr SettingsRect kWifiSetup{16, 284, 434, 80};
constexpr SettingsRect kBack{16, 376, 434, 80};
// The character state page.
constexpr LabeledButton kModeButtons[] = {
  {{16, 16, 209, 136}, SettingsAction::Idle, "Idle", 3},
  {{241, 16, 209, 136}, SettingsAction::Working, "Working", 3},
  {{16, 165, 209, 136}, SettingsAction::Complete, "Complete", 3},
  {{241, 165, 209, 136}, SettingsAction::Attention, "Attention", 3},
  {{16, 314, 209, 136}, SettingsAction::Surprise, "Surprise", 3},
  {{241, 314, 209, 136}, SettingsAction::Back, "Back", 3},
};
}

class SettingsMenu {
 public:
  explicit SettingsMenu(uint8_t brightness, uint8_t soundVolume = 50, bool compact = false)
      : brightness_(brightness), soundVolume_(soundVolume), compact_(compact) {}

  bool isOpen() const { return open_; }
  bool compact() const { return compact_; }
  bool networkPage() const { return page_ == Page::Network; }
  bool statesPage() const { return page_ == Page::States; }
  void open() { open_ = true; page_ = Page::Main; }
  void close() { open_ = false; page_ = Page::Main; }
  void openNetwork() { page_ = Page::Network; }
  void openStates() { page_ = Page::States; }
  void back() { page_ = Page::Main; }
  uint8_t brightness() const { return brightness_; }
  uint8_t soundVolume() const { return soundVolume_; }
  void setSoundVolume(uint8_t volume) { soundVolume_ = volume > 100 ? 100 : volume; }

  SettingsAction tap(int16_t x, int16_t y) {
    if (!open_) return SettingsAction::None;
    return compact_ ? tapCompact(x, y) : tapFull(x, y);
  }

 private:
  enum class Page : uint8_t { Main, Network, States };

  SettingsAction tapFull(int16_t x, int16_t y) {
    using namespace settings_layout;
    if (page_ == Page::Network) {
      if (kWifiSetup.contains(x, y)) return SettingsAction::WifiSetup;
      if (kBack.contains(x, y)) return SettingsAction::Back;
      return SettingsAction::None;
    }
    if (kWifiStatus.contains(x, y)) return SettingsAction::Wifi;
    const SettingsAction step = tapSteppers(x, y, kBrightnessDown, kBrightnessUp, kVolumeDown, kVolumeUp);
    if (step != SettingsAction::None) return step;
    for (const LabeledButton& button : kModeButtons)
      if (button.rect.contains(x, y)) return button.action;
    return SettingsAction::None;
  }

  SettingsAction tapCompact(int16_t x, int16_t y) {
    using namespace compact_layout;
    if (page_ == Page::Network) {
      if (kWifiSetup.contains(x, y)) return SettingsAction::WifiSetup;
      if (kBack.contains(x, y)) return SettingsAction::Back;
      return SettingsAction::None;
    }
    if (page_ == Page::States) {
      for (const LabeledButton& button : kModeButtons)
        if (button.rect.contains(x, y)) return button.action;
      return SettingsAction::None;
    }
    const SettingsAction step = tapSteppers(x, y, kBrightnessDown, kBrightnessUp, kVolumeDown, kVolumeUp);
    if (step != SettingsAction::None) return step;
    if (kWifi.contains(x, y)) return SettingsAction::Wifi;
    if (kStates.contains(x, y)) return SettingsAction::States;
    if (kClose.contains(x, y)) return SettingsAction::Close;
    return SettingsAction::None;
  }

  SettingsAction tapSteppers(int16_t x, int16_t y, const SettingsRect& brightnessDown,
                             const SettingsRect& brightnessUp, const SettingsRect& volumeDown,
                             const SettingsRect& volumeUp) {
    if (brightnessDown.contains(x, y)) {
      brightness_ = brightness_ > 55 ? brightness_ - 25 : 30;
      return SettingsAction::BrightnessDown;
    }
    if (brightnessUp.contains(x, y)) {
      brightness_ = brightness_ < 230 ? brightness_ + 25 : 255;
      return SettingsAction::BrightnessUp;
    }
    if (volumeDown.contains(x, y)) {
      soundVolume_ = soundVolume_ > 25 ? soundVolume_ - 25 : 0;
      return SettingsAction::SoundDown;
    }
    if (volumeUp.contains(x, y)) {
      soundVolume_ = soundVolume_ < 75 ? soundVolume_ + 25 : 100;
      return SettingsAction::SoundUp;
    }
    return SettingsAction::None;
  }

  uint8_t brightness_;
  uint8_t soundVolume_;
  bool compact_;
  bool open_ = false;
  Page page_ = Page::Main;
};
}
