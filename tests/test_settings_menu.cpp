#include "../firmware/AgentCompanion/src/SettingsMenu.h"
#include <cassert>
#include <cstddef>
#include <cstring>
#include <iostream>

namespace {
// The firmware's font is 6 x 8 pixels at text size 1 (textWidth() in AgentCompanion.ino), and
// drawSettingsButton() keeps a label at least 10 pixels from the button's left edge.
constexpr int kGlyphWidth = 6;
constexpr int kGlyphHeight = 8;
constexpr int kLabelMargin = 10;

// A layout draws its state buttons alike: one text size, and each label inside its button.
template <size_t N>
void checkStateButtons(const copilot::LabeledButton (&buttons)[N]) {
  for (const copilot::LabeledButton& button : buttons) {
    assert(button.textSize == buttons[0].textSize);
    const int width = static_cast<int>(std::strlen(button.label)) * kGlyphWidth * button.textSize;
    assert(width + 2 * kLabelMargin <= button.rect.width);
    assert(kGlyphHeight * button.textSize <= button.rect.height);
  }
}

template <size_t N>
const char* labelFor(const copilot::LabeledButton (&buttons)[N], copilot::SettingsAction action) {
  for (const copilot::LabeledButton& button : buttons)
    if (button.action == action) return button.label;
  return nullptr;
}
}

int main() {
  using copilot::SettingsAction;
  copilot::SettingsMenu menu(155);
  assert(!menu.isOpen());
  assert(menu.tap(100, 230) == SettingsAction::None);
  menu.open();
  assert(menu.isOpen());
  assert(menu.tap(233, 60) == SettingsAction::Wifi);
  assert(menu.tap(400, 60) == SettingsAction::None);
  menu.openNetwork();
  assert(menu.networkPage());
  assert(menu.tap(200, 350) == SettingsAction::WifiSetup);
  assert(menu.tap(200, 410) == SettingsAction::Back);
  menu.back();
  assert(!menu.networkPage());
  assert(menu.soundVolume() == 50);
  assert(menu.tap(170, 130) == SettingsAction::BrightnessDown);
  assert(menu.brightness() == 130);
  for (int i = 0; i < 10; ++i) menu.tap(170, 130);
  assert(menu.brightness() == 30);
  for (int i = 0; i < 20; ++i) menu.tap(290, 130);
  assert(menu.brightness() == 255);
  assert(menu.tap(170, 180) == SettingsAction::SoundDown);
  assert(menu.soundVolume() == 25);
  assert(menu.tap(170, 180) == SettingsAction::SoundDown);
  assert(menu.soundVolume() == 0);
  assert(menu.tap(170, 180) == SettingsAction::SoundDown);
  assert(menu.soundVolume() == 0);
  for (int i = 0; i < 5; ++i) {
    assert(menu.tap(290, 180) == SettingsAction::SoundUp);
  }
  assert(menu.soundVolume() == 100);
  menu.setSoundVolume(255);
  assert(menu.soundVolume() == 100);
  // The installed character's name is display-only; the daemon installs a different pack.
  assert(menu.tap(100, 250) == SettingsAction::None);
  assert(menu.tap(300, 250) == SettingsAction::None);
  assert(menu.tap(100, 315) == SettingsAction::Idle);
  assert(menu.tap(300, 315) == SettingsAction::Working);
  assert(menu.tap(100, 350) == SettingsAction::Complete);
  assert(menu.tap(300, 350) == SettingsAction::Attention);
  assert(menu.tap(100, 390) == SettingsAction::Surprise);
  assert(menu.tap(300, 390) == SettingsAction::Close);
  assert(menu.tap(230, 230) == SettingsAction::None);
  menu.close();
  assert(!menu.isOpen());

  // The compact layout spreads larger controls over three pages.
  copilot::SettingsMenu compact(155, 50, true);
  assert(compact.compact());
  compact.open();
  assert(compact.tap(60, 90) == SettingsAction::BrightnessDown);
  assert(compact.brightness() == 130);
  assert(compact.tap(400, 90) == SettingsAction::BrightnessUp);
  assert(compact.brightness() == 155);
  assert(compact.tap(60, 220) == SettingsAction::SoundDown);
  assert(compact.soundVolume() == 25);
  assert(compact.tap(400, 220) == SettingsAction::SoundUp);
  assert(compact.soundVolume() == 50);
  assert(compact.tap(233, 90) == SettingsAction::None);
  assert(compact.tap(233, 20) == SettingsAction::None);
  assert(compact.tap(100, 320) == SettingsAction::Wifi);
  assert(compact.tap(350, 320) == SettingsAction::States);
  assert(compact.tap(233, 420) == SettingsAction::Close);
  compact.openNetwork();
  assert(compact.networkPage() && !compact.statesPage());
  assert(compact.tap(233, 320) == SettingsAction::WifiSetup);
  assert(compact.tap(233, 420) == SettingsAction::Back);
  assert(compact.tap(233, 100) == SettingsAction::None);
  compact.back();
  compact.openStates();
  assert(compact.statesPage() && !compact.networkPage());
  assert(compact.tap(100, 80) == SettingsAction::Idle);
  assert(compact.tap(350, 80) == SettingsAction::Working);
  assert(compact.tap(100, 230) == SettingsAction::Complete);
  assert(compact.tap(350, 230) == SettingsAction::Attention);
  assert(compact.tap(100, 380) == SettingsAction::Surprise);
  assert(compact.tap(350, 380) == SettingsAction::Back);
  assert(compact.tap(233, 158) == SettingsAction::None);
  compact.back();
  assert(!compact.statesPage() && compact.tap(60, 90) == SettingsAction::BrightnessDown);
  compact.openStates();
  compact.close();
  compact.open();
  assert(!compact.statesPage());

  // Every board names the character states the same way: the full layout (AMOLED boards) and the
  // compact layout (LCD-1.54) use the same labels.
  checkStateButtons(copilot::settings_layout::kModeButtons);
  checkStateButtons(copilot::compact_layout::kModeButtons);
  for (SettingsAction action : {SettingsAction::Idle, SettingsAction::Working, SettingsAction::Complete,
                                SettingsAction::Attention, SettingsAction::Surprise}) {
    const char* full = labelFor(copilot::settings_layout::kModeButtons, action);
    const char* small = labelFor(copilot::compact_layout::kModeButtons, action);
    assert(full && small && std::strcmp(full, small) == 0);
  }
  std::cout << "PASS: settings geometry, brightness, sound, Wi-Fi, modes and close action\n";
  std::cout << "PASS: compact settings pages, steppers, state buttons and back\n";
  std::cout << "PASS: every layout's state buttons share labels and a text size, and each label fits\n";
}
